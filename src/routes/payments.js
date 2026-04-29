import { Router } from 'express';
import Stripe from 'stripe';
import axios from 'axios';
import { query } from '../config/database.js';

const router = Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// M-Pesa OAuth token
const getMpesaToken = async () => {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const baseUrl = process.env.MPESA_ENVIRONMENT === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

  const response = await axios.get(
    `${baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    }
  );

  return response.data.access_token;
};

// M-Pesa STK Push
router.post('/mpesa/stkpush', async (req, res) => {
  try {
    const { orderId, phoneNumber } = req.body;

    if (!orderId || !phoneNumber) {
      return res.status(400).json({ error: 'Order ID and phone number are required' });
    }

    // Get order
    const orderResult = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // Format phone number (remove leading 0 or +254, add 254)
    let formattedPhone = phoneNumber.replace(/\s/g, '');
    if (formattedPhone.startsWith('+')) {
      formattedPhone = formattedPhone.substring(1);
    }
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '254' + formattedPhone.substring(1);
    }
    if (!formattedPhone.startsWith('254')) {
      formattedPhone = '254' + formattedPhone;
    }

    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const shortCode = process.env.MPESA_BUSINESS_SHORT_CODE;
    const passKey = process.env.MPESA_PASS_KEY;
    const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString('base64');

    const baseUrl = process.env.MPESA_ENVIRONMENT === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

    const stkResponse = await axios.post(
      `${baseUrl}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.ceil(parseFloat(order.total)),
        PartyA: formattedPhone,
        PartyB: shortCode,
        PhoneNumber: formattedPhone,
        CallBackURL: process.env.MPESA_CALLBACK_URL,
        AccountReference: order.order_number,
        TransactionDesc: `Payment for order ${order.order_number}`,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Create payment record
    await query(
      `INSERT INTO payments (order_id, method, amount, currency, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        orderId,
        'mpesa',
        order.total,
        'KES',
        'pending',
        JSON.stringify({
          checkoutRequestId: stkResponse.data.CheckoutRequestID,
          merchantRequestId: stkResponse.data.MerchantRequestID,
          phoneNumber: formattedPhone,
        }),
      ]
    );

    res.json({
      success: true,
      checkoutRequestId: stkResponse.data.CheckoutRequestID,
      message: 'STK Push sent. Please check your phone to complete payment.',
    });
  } catch (error) {
    console.error('M-Pesa STK Push error:', error.response?.data || error);
    res.status(500).json({ error: 'Failed to initiate M-Pesa payment' });
  }
});

// M-Pesa Callback
router.post('/mpesa/callback', async (req, res) => {
  try {
    const { Body } = req.body;
    
    if (!Body?.stkCallback) {
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const callback = Body.stkCallback;
    const checkoutRequestId = callback.CheckoutRequestID;
    const resultCode = callback.ResultCode;

    // Find payment by checkout request ID
    const paymentResult = await query(
      `SELECT * FROM payments WHERE metadata->>'checkoutRequestId' = $1`,
      [checkoutRequestId]
    );

    if (paymentResult.rows.length === 0) {
      console.error('Payment not found for checkout request:', checkoutRequestId);
      return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const payment = paymentResult.rows[0];

    if (resultCode === 0) {
      // Payment successful
      const callbackMetadata = callback.CallbackMetadata?.Item || [];
      const mpesaReceiptNumber = callbackMetadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      const transactionDate = callbackMetadata.find(i => i.Name === 'TransactionDate')?.Value;
      const amount = callbackMetadata.find(i => i.Name === 'Amount')?.Value;

      // Update payment
      await query(
        `UPDATE payments SET 
          status = 'completed', 
          transaction_id = $1,
          metadata = metadata || $2
         WHERE id = $3`,
        [
          mpesaReceiptNumber,
          JSON.stringify({ transactionDate, paidAmount: amount }),
          payment.id,
        ]
      );

      // Update order
      await query(
        `UPDATE orders SET payment_status = 'paid', status = 'confirmed' WHERE id = $1`,
        [payment.order_id]
      );
    } else {
      // Payment failed
      await query(
        `UPDATE payments SET 
          status = 'failed',
          metadata = metadata || $1
         WHERE id = $2`,
        [
          JSON.stringify({ resultCode, resultDesc: callback.ResultDesc }),
          payment.id,
        ]
      );

      await query(
        `UPDATE orders SET payment_status = 'failed' WHERE id = $1`,
        [payment.order_id]
      );
    }

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (error) {
    console.error('M-Pesa callback error:', error);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// Check M-Pesa payment status
router.get('/mpesa/status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    const paymentResult = await query(
      `SELECT * FROM payments WHERE order_id = $1 AND method = 'mpesa' ORDER BY created_at DESC LIMIT 1`,
      [orderId]
    );

    if (paymentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const payment = paymentResult.rows[0];
    
    res.json({
      status: payment.status,
      transactionId: payment.transaction_id,
    });
  } catch (error) {
    console.error('Check payment status error:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// Stripe Create Checkout Session
router.post('/stripe/create-session', async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Order ID is required' });
    }

    // Get order with items
    const orderResult = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    const itemsResult = await query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [orderId]
    );

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: itemsResult.rows.map(item => ({
        price_data: {
          currency: 'kes',
          product_data: {
            name: item.name,
          },
          unit_amount: Math.round(parseFloat(item.price) * 100), // Stripe uses cents
        },
        quantity: item.quantity,
      })),
      shipping_options: order.shipping_cost > 0 ? [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: {
            amount: Math.round(parseFloat(order.shipping_cost) * 100),
            currency: 'kes',
          },
          display_name: 'Standard Shipping',
        },
      }] : [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: {
            amount: 0,
            currency: 'kes',
          },
          display_name: 'Free Shipping',
        },
      }],
      metadata: {
        orderId: order.id,
        orderNumber: order.order_number,
      },
      success_url: `${process.env.FRONTEND_URL}/checkout/success?order=${order.order_number}`,
      cancel_url: `${process.env.FRONTEND_URL}/checkout?order=${order.id}`,
    });

    // Create payment record
    await query(
      `INSERT INTO payments (order_id, method, amount, currency, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        orderId,
        'stripe',
        order.total,
        'KES',
        'pending',
        JSON.stringify({ sessionId: session.id }),
      ]
    );

    res.json({ 
      sessionId: session.id,
      url: session.url 
    });
  } catch (error) {
    console.error('Stripe create session error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe Webhook
router.post('/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata.orderId;

    // Update payment
    await query(
      `UPDATE payments SET 
        status = 'completed',
        transaction_id = $1
       WHERE order_id = $2 AND method = 'stripe' AND status = 'pending'`,
      [session.payment_intent, orderId]
    );

    // Update order
    await query(
      `UPDATE orders SET payment_status = 'paid', status = 'confirmed' WHERE id = $1`,
      [orderId]
    );
  }

  res.json({ received: true });
});

export default router;
