import { query, withTransaction } from '../config/database.js';

// Orders reserve stock the moment they are placed. If nobody pays, give it back.
const EXPIRY_MINUTES = Number.parseInt(process.env.ORDER_EXPIRY_MINUTES, 10) || 30;
const CHECK_EVERY_MS = 5 * 60 * 1000;

/** Puts an order's items back into stock. Call it inside a transaction. */
export async function restoreOrderStock(client, orderId) {
  await client.query(
    `UPDATE products p
     SET stock_quantity = p.stock_quantity + s.qty
     FROM (
       SELECT product_id, SUM(quantity)::int AS qty
       FROM order_items
       WHERE order_id = $1 AND product_id IS NOT NULL
       GROUP BY product_id
     ) s
     WHERE p.id = s.product_id`,
    [orderId]
  );
}

/** Cancels unpaid orders older than the expiry window and restores their stock. */
export async function expireUnpaidOrders() {
  const { rows } = await query(
    `SELECT id, order_number FROM orders
     WHERE status = 'pending'
       AND payment_status IN ('pending', 'failed')
       AND created_at < now() - make_interval(mins => $1)`,
    [EXPIRY_MINUTES]
  );

  let expired = 0;

  for (const order of rows) {
    const done = await withTransaction(async (client) => {
      // Re-checks the conditions, so an order paid a moment ago is left alone
      const cancelled = await client.query(
        `UPDATE orders SET status = 'cancelled'
         WHERE id = $1 AND status = 'pending' AND payment_status IN ('pending', 'failed')
         RETURNING id`,
        [order.id]
      );
      if (cancelled.rowCount === 0) return false;

      await restoreOrderStock(client, order.id);
      await client.query(
        `UPDATE payments
         SET status = 'failed',
             metadata = COALESCE(metadata, '{}'::jsonb) || '{"expired": true}'::jsonb
         WHERE order_id = $1 AND status = 'pending'`,
        [order.id]
      );
      return true;
    });

    if (done) {
      expired++;
      console.log(`Expired unpaid order ${order.order_number}`);
    }
  }

  return expired;
}

export function startOrderExpiryJob() {
  const run = () =>
    expireUnpaidOrders().catch((err) =>
      console.error('Order expiry job failed:', err.message)
    );

  setTimeout(run, 30_000).unref();
  setInterval(run, CHECK_EVERY_MS).unref();
  console.log(`🕒 Unpaid orders expire after ${EXPIRY_MINUTES} minutes`);
}
