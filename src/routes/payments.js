import { Router } from 'express';
import Stripe from 'stripe';
import axios from 'axios';
import crypto from 'crypto';
import { query, withTransaction } from '../config/database.js';
import { optionalAuth } from '../middlewares/auth.js';

const router = Router();

/* ---------------------------------- setup ---------------------------------- */

// Card payments are optional: the server starts fine without Stripe keys
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const MPESA_BASE_URL =
  process.env.MPESA_ENVIRONMENT === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECENT_PROMPT_SECONDS = 60; // don't send a second prompt while one is fresh
const STK_QUERY_AFTER_MS = 15_000; // ask Safaricom directly if no callback by then
const STK_QUERY_EVERY_MS = 10_000;

const asString = (value) => (typeof value === 'string' ? value : '');

// 0712345678, 712345678, +254712345678, 254 712 345 678 ... -> 254712345678
function normalizeKenyanPhone(input) {
  const compact = asString(input).replace(/[\s\-()]/g, '');
  const match = compact.match(/^(?:\+?254|0)?([17]\d{8})$/);
  return match ? `254${match[1]}` : null;
}

// What the customer sees for the common M-Pesa result codes
const MPESA_FAILURE_MESSAGES = {
  1: 'Your M-Pesa balance is too low for this payment.',
  1032: 'The request was cancelled on your phone.',
  1037: "We couldn't reach your phone. Make sure it's on and try again.",
  2001: 'The M-Pesa PIN entered was incorrect.',
};
const friendlyFailure = (resultCode) =>
  MPESA_FAILURE_MESSAGES[Number(resultCode)] ||
  'The M-Pesa payment was not completed. Please try again.';

/* ----------------------------- order authorisation ---------------------------- */

/**
 * Returns the order only if the caller may act on it: its owner (logged in),
 * an admin, or, for guest orders, someone who knows the checkout email.
 * Otherwise null, so callers answer 404 and never reveal which orders exist.
 */
async function loadAuthorizedOrder(req, orderId) {
  if (!UUID_RE.test(orderId)) return null;

  const { rows } = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = rows[0];
  if (!order) return null;

  const email = asString(req.body?.email ?? req.query?.email).trim().toLowerCase();
  const isAdmin = req.user?.role === 'admin';
  const isOwner = Boolean(req.user?.id) && order.user_id === req.user.id;
  const isGuestMatch =
    !order.user_id && email !== '' && email === String(order.email).toLowerCase();

  return isAdmin || isOwner || isGuestMatch ? order : null;
}

// Returns an error message if this order can't be paid right now
function paymentBlockedReason(order) {
  if (order.payment_status === 'paid') return 'This order has already been paid.';
  if (order.status === 'cancelled') {
    return 'This order was cancelled. Please place a new order.';
  }
  return null;
}

/* ------------------------------ settling payments ----------------------------- */

// Tries to take the stock back for an order that had been cancelled
async function tryReserveStock(client, orderId) {
  const { rows: items } = await client.query(
    'SELECT product_id, quantity FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL',
    [orderId]
  );

  await client.query('SAVEPOINT reserve_stock');
  for (const item of items) {
    const result = await client.query(
      `UPDATE products SET stock_quantity = stock_quantity - $1
       WHERE id = $2 AND stock_quantity >= $1`,
      [item.quantity, item.product_id]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK TO SAVEPOINT reserve_stock');
      return false;
    }
  }
  await client.query('RELEASE SAVEPOINT reserve_stock');
  return true;
}

/**
 * The single place that marks a payment completed or failed. Safe to call any
 * number of times for the same payment (callbacks get retried, the status
 * endpoint can race the callback), and safe if the order expired meanwhile.
 *
 * outcome: { success, transactionId?, paidAmount?, details? }
 * Returns the payment's final status.
 */
async function settlePayment(paymentId, outcome) {
  return withTransaction(async (client) => {
    const paymentResult = await client.query(
      'SELECT * FROM payments WHERE id = $1 FOR UPDATE',
      [paymentId]
    );
    const payment = paymentResult.rows[0];
    if (!payment) return null;

    // Already done: only fill in a receipt number that arrived late
    if (payment.status === 'completed') {
      if (outcome.success && outcome.transactionId && !payment.transaction_id) {
        await client.query('UPDATE payments SET transaction_id = $1 WHERE id = $2', [
          outcome.transactionId,
          payment.id,
        ]);
      }
      return 'completed';
    }
    // A failure report can't change a payment that already left "pending"
    if (!outcome.success && payment.status !== 'pending') return payment.status;

    const orderResult = await client.query(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
      [payment.order_id]
    );
    const order = orderResult.rows[0];

    const details = JSON.stringify(outcome.details ?? {});

    if (!outcome.success) {
      await client.query(
        `UPDATE payments
         SET status = 'failed', metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [details, payment.id]
      );
      // Never downgrade an order that another payment already settled
      await client.query(
        `UPDATE orders SET payment_status = 'failed'
         WHERE id = $1 AND payment_status <> 'paid'`,
        [order.id]
      );
      return 'failed';
    }

    // Refuse to confirm an order for less than its total
    const expected = Math.ceil(Number(order.total));
    if (outcome.paidAmount != null && Number(outcome.paidAmount) < expected) {
      console.error(
        `UNDERPAID: order ${order.order_number} expects KES ${expected}, received ${outcome.paidAmount}`
      );
      await client.query(
        `UPDATE payments
         SET status = 'failed',
             metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
         WHERE id = $2`,
        [JSON.stringify({ ...(outcome.details ?? {}), underpaid: true }), payment.id]
      );
      return 'failed';
    }

    await client.query(
      `UPDATE payments
       SET status = 'completed',
           transaction_id = COALESCE($1, transaction_id),
           metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE id = $3`,
      [outcome.transactionId ?? null, details, payment.id]
    );

    // Paid after the unpaid-order expiry cancelled it: take the stock back if we can
    let stockAvailable = true;
    if (order.status === 'cancelled') {
      stockAvailable = await tryReserveStock(client, order.id);
    }

    if (stockAvailable) {
      await client.query(
        `UPDATE orders
         SET payment_status = 'paid',
             status = CASE WHEN status IN ('pending', 'cancelled') THEN 'confirmed' ELSE status END
         WHERE id = $1`,
        [order.id]
      );
    } else {
      console.error(
        `NEEDS REVIEW: order ${order.order_number} was paid after it was cancelled and stock is gone. Refund or fulfil manually.`
      );
      await client.query(
        `UPDATE orders
         SET payment_status = 'paid',
             notes = CONCAT_WS(chr(10), notes, $2::text)
         WHERE id = $1`,
        [order.id, 'PAID AFTER CANCELLATION AND OUT OF STOCK: needs manual review or refund']
      );
    }

    return 'completed';
  });
}

/* ---------------------------------- M-Pesa ---------------------------------- */

let cachedToken = null; // { value, expiresAt }

async function getMpesaToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const { data } = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  const ttlMs = (Number(data.expires_in) || 3600) * 1000;
  cachedToken = { value: data.access_token, expiresAt: Date.now() + ttlMs - 60_000 };
  return cachedToken.value;
}

function stkCredentials() {
  const shortCode = process.env.MPESA_BUSINESS_SHORT_CODE;
  const passKey = process.env.MPESA_PASS_KEY;
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString('base64');
  return { shortCode, timestamp, password };
}

// Asks Safaricom for the real outcome. Returns null while the customer is still paying.
async function queryStkStatus(checkoutRequestId) {
  try {
    const token = await getMpesaToken();
    const { shortCode, timestamp, password } = stkCredentials();
    const { data } = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpushquery/v1/query`,
      {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (data.ResultCode === undefined) return null;
    return { resultCode: Number(data.ResultCode), resultDesc: data.ResultDesc };
  } catch {
    // Daraja answers with an error while the transaction is still being processed
    return null;
  }
}

const lastStkQuery = new Map(); // paymentId -> timestamp, keeps us from hammering Daraja

async function refreshPendingPayment(payment) {
  const checkoutRequestId = payment.metadata?.checkoutRequestId;
  const age = Date.now() - new Date(payment.created_at).getTime();
  const lastChecked = lastStkQuery.get(payment.id) ?? 0;

  if (!checkoutRequestId || age < STK_QUERY_AFTER_MS) return payment;
  if (Date.now() - lastChecked < STK_QUERY_EVERY_MS) return payment;
  lastStkQuery.set(payment.id, Date.now());

  const result = await queryStkStatus(checkoutRequestId);
  if (!result) return payment;

  await settlePayment(
    payment.id,
    result.resultCode === 0
      ? { success: true, details: { verifiedBy: 'stk-query' } }
      : {
          success: false,
          details: { resultCode: result.resultCode, resultDesc: result.resultDesc },
        }
  );
  lastStkQuery.delete(payment.id);

  const { rows } = await query('SELECT * FROM payments WHERE id = $1', [payment.id]);
  return rows[0] ?? payment;
}

// M-Pesa STK Push
router.post('/mpesa/stkpush', optionalAuth, async (req, res) => {
  try {
    const orderId = asString(req.body?.orderId);
    if (!orderId || !req.body?.phoneNumber) {
      return res.status(400).json({ error: 'Order ID and phone number are required' });
    }

    const phone = normalizeKenyanPhone(req.body.phoneNumber);
    if (!phone) {
      return res
        .status(400)
        .json({ error: 'Enter a valid Safaricom number, like 0712 345 678' });
    }

    const order = await loadAuthorizedOrder(req, orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const blocked = paymentBlockedReason(order);
    if (blocked) return res.status(409).json({ error: blocked });

    const recent = await query(
      `SELECT 1 FROM payments
       WHERE order_id = $1 AND method = 'mpesa' AND status = 'pending'
         AND created_at > now() - make_interval(secs => $2)
       LIMIT 1`,
      [order.id, RECENT_PROMPT_SECONDS]
    );
    if (recent.rowCount > 0) {
      return res.status(429).json({
        error: 'A payment prompt was just sent to your phone. Please wait a minute before trying again.',
      });
    }

    const token = await getMpesaToken();
    const { shortCode, timestamp, password } = stkCredentials();

    const stkResponse = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.ceil(Number(order.total)),
        PartyA: phone,
        PartyB: shortCode,
        PhoneNumber: phone,
        CallBackURL: process.env.MPESA_CALLBACK_URL,
        AccountReference: order.order_number,
        TransactionDesc: `Payment for order ${order.order_number}`,
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    await query(
      `INSERT INTO payments (order_id, method, amount, currency, status, metadata)
       VALUES ($1, 'mpesa', $2, 'KES', 'pending', $3)`,
      [
        order.id,
        order.total,
        JSON.stringify({
          checkoutRequestId: stkResponse.data.CheckoutRequestID,
          merchantRequestId: stkResponse.data.MerchantRequestID,
          phoneNumber: phone,
        }),
      ]
    );

    // The checkout request id stays on the server: the browser never needs it
    res.json({
      success: true,
      message: 'STK Push sent. Please check your phone to complete payment.',
    });
  } catch (error) {
    console.error('M-Pesa STK Push error:', error.response?.data || error.message);
    res.status(502).json({ error: 'We could not reach M-Pesa. Please try again.' });
  }
});

function isValidCallbackSecret(candidate) {
  const expected = process.env.MPESA_CALLBACK_SECRET;
  if (!expected || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * M-Pesa callback. Safaricom doesn't sign these, so the URL itself carries a
 * secret: set MPESA_CALLBACK_URL to
 *   https://<public-host>/api/payments/mpesa/callback/<MPESA_CALLBACK_SECRET>
 */
router.post('/mpesa/callback/:secret', async (req, res) => {
  if (!isValidCallbackSecret(req.params.secret)) {
    console.warn('Rejected an M-Pesa callback with a bad secret');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ack = () => res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return ack();

    const { rows } = await query(
      `SELECT id FROM payments
       WHERE method = 'mpesa' AND metadata->>'checkoutRequestId' = $1`,
      [callback.CheckoutRequestID]
    );
    if (rows.length === 0) {
      console.error('Payment not found for checkout request:', callback.CheckoutRequestID);
      return ack();
    }

    const metadataItems = callback.CallbackMetadata?.Item ?? [];
    const pick = (name) => metadataItems.find((item) => item.Name === name)?.Value;

    if (Number(callback.ResultCode) === 0) {
      await settlePayment(rows[0].id, {
        success: true,
        transactionId: pick('MpesaReceiptNumber'),
        paidAmount: pick('Amount'),
        details: {
          transactionDate: pick('TransactionDate'),
          paidAmount: pick('Amount'),
        },
      });
    } else {
      await settlePayment(rows[0].id, {
        success: false,
        details: { resultCode: callback.ResultCode, resultDesc: callback.ResultDesc },
      });
    }
  } catch (error) {
    // Still acknowledge; the status endpoint re-checks pending payments with Safaricom
    console.error('M-Pesa callback error:', error);
  }

  ack();
});

// Check M-Pesa payment status (polled by the checkout page)
router.get('/mpesa/status/:orderId', optionalAuth, async (req, res) => {
  try {
    const order = await loadAuthorizedOrder(req, req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const paymentResult = await query(
      `SELECT * FROM payments
       WHERE order_id = $1 AND method = 'mpesa'
       ORDER BY created_at DESC LIMIT 1`,
      [order.id]
    );
    let payment = paymentResult.rows[0];
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    // No callback yet (or it can't reach us, e.g. on localhost): ask Safaricom
    if (payment.status === 'pending') {
      payment = await refreshPendingPayment(payment);
    }

    res.json({
      status: payment.status,
      transactionId: payment.transaction_id,
      ...(payment.status === 'failed' && {
        message: friendlyFailure(payment.metadata?.resultCode),
      }),
    });
  } catch (error) {
    console.error('Check payment status error:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

/* ---------------------------------- Stripe ---------------------------------- */

const stripeDisabled = (res) =>
  res.status(503).json({ error: 'Card payments are not available right now' });

// Stripe Create Checkout Session
router.post('/stripe/create-session', optionalAuth, async (req, res) => {
  if (!stripe) return stripeDisabled(res);

  try {
    const orderId = asString(req.body?.orderId);
    if (!orderId) return res.status(400).json({ error: 'Order ID is required' });

    const order = await loadAuthorizedOrder(req, orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const blocked = paymentBlockedReason(order);
    if (blocked) return res.status(409).json({ error: blocked });

    const itemsResult = await query('SELECT * FROM order_items WHERE order_id = $1', [
      order.id,
    ]);

    const shippingCost = Number(order.shipping_cost);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: itemsResult.rows.map((item) => ({
        price_data: {
          currency: 'kes',
          product_data: { name: item.name },
          unit_amount: Math.round(Number(item.price) * 100), // Stripe uses cents
        },
        quantity: item.quantity,
      })),
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: Math.round(shippingCost * 100), currency: 'kes' },
            display_name: shippingCost > 0 ? 'Standard Shipping' : 'Free Shipping',
          },
        },
      ],
      metadata: { orderId: order.id, orderNumber: order.order_number },
      success_url: `${process.env.FRONTEND_URL}/checkout/success?order=${order.order_number}`,
      cancel_url: `${process.env.FRONTEND_URL}/checkout`,
    });

    await query(
      `INSERT INTO payments (order_id, method, amount, currency, status, metadata)
       VALUES ($1, 'stripe', $2, 'KES', 'pending', $3)`,
      [order.id, order.total, JSON.stringify({ sessionId: session.id })]
    );

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Stripe create session error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe Webhook (the raw body is set up in index.js)
router.post('/stripe/webhook', async (req, res) => {
  if (!stripe) return stripeDisabled(res);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.expired'
    ) {
      const session = event.data.object;
      const { rows } = await query(
        `SELECT id FROM payments
         WHERE method = 'stripe' AND metadata->>'sessionId' = $1`,
        [session.id]
      );

      if (rows[0]) {
        await settlePayment(
          rows[0].id,
          event.type === 'checkout.session.completed'
            ? { success: true, transactionId: session.payment_intent }
            : { success: false, details: { reason: 'session expired' } }
        );
      }
    }
  } catch (error) {
    console.error('Stripe webhook handling error:', error);
    return res.status(500).json({ error: 'Webhook handling failed' });
  }

  res.json({ received: true });
});

export default router;
