import { Router } from "express";
import crypto from "crypto";
import { query, withTransaction } from "../config/database.js";
import { authenticate, optionalAuth } from "../middlewares/auth.js";

const router = Router();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Generate order number: SLX-<time>-<6 random hex chars>
const generateOrderNumber = () =>
  `SLX-${Date.now().toString(36).toUpperCase()}-${crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase()}`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FREE_SHIPPING_THRESHOLD = 50000;
const SHIPPING_FEE = 500;

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Create order
router.post("/", optionalAuth, async (req, res) => {
  try {
    const {
      email,
      phone,
      shippingAddress,
      billingAddress,
      paymentMethod,
      notes,
    } = req.body;

    const sessionId = req.headers["x-session-id"];
    const userId = req.user?.id;

    if (!email || !shippingAddress) {
      return res
        .status(400)
        .json({ error: "Email and shipping address are required" });
    }

    if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: "A valid email is required" });
    }

    if (!isPlainObject(shippingAddress)) {
      return res.status(400).json({ error: "Shipping address is invalid" });
    }

    if (billingAddress != null && !isPlainObject(billingAddress)) {
      return res.status(400).json({ error: "Billing address is invalid" });
    }

    if (!paymentMethod || !["mpesa", "stripe"].includes(paymentMethod)) {
      return res
        .status(400)
        .json({ error: "Valid payment method is required" });
    }

    if (!userId && !sessionId) {
      return res.status(400).json({ error: "No cart found" });
    }

    const order = await withTransaction(async (client) => {
      // Load the cart with current prices; ignore products that are no longer active
      const ownerCol = userId ? "ci.user_id" : "ci.session_id";
      const cart = await client.query(
        `SELECT ci.product_id, ci.quantity, p.name, p.price
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id AND p.status = 'active'
         WHERE ${ownerCol} = $1`,
        [userId || sessionId],
      );

      if (cart.rows.length === 0) {
        throw new HttpError(400, "Cart is empty");
      }

      // Totals are always computed on the server from DB prices
      const subtotal =
        Math.round(
          cart.rows.reduce(
            (sum, i) => sum + parseFloat(i.price) * i.quantity,
            0,
          ) * 100,
        ) / 100;
      const shippingCost =
        subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
      const tax = 0; // Could calculate VAT here
      const total = subtotal + shippingCost + tax;

      const orderResult = await client.query(
        `INSERT INTO orders (
           order_number, user_id, email, phone, shipping_address, billing_address,
           subtotal, shipping_cost, tax, total, status, payment_method, payment_status, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,'pending',$12)
         RETURNING *`,
        [
          generateOrderNumber(),
          userId || null,
          email.trim().toLowerCase(),
          phone || null,
          JSON.stringify(shippingAddress),
          billingAddress ? JSON.stringify(billingAddress) : null,
          subtotal,
          shippingCost,
          tax,
          total,
          paymentMethod,
          notes || null,
        ],
      );
      const newOrder = orderResult.rows[0];

      for (const item of cart.rows) {
        // Atomic: only decrements when enough stock remains, so no overselling
        const upd = await client.query(
          `UPDATE products
           SET stock_quantity = stock_quantity - $1
           WHERE id = $2 AND stock_quantity >= $1`,
          [item.quantity, item.product_id],
        );
        if (upd.rowCount === 0) {
          throw new HttpError(409, `Insufficient stock for ${item.name}`);
        }

        await client.query(
          `INSERT INTO order_items (order_id, product_id, name, price, quantity)
           VALUES ($1, $2, $3, $4, $5)`,
          [newOrder.id, item.product_id, item.name, item.price, item.quantity],
        );
      }

      // Clear the cart
      await client.query(
        `DELETE FROM cart_items WHERE ${userId ? "user_id" : "session_id"} = $1`,
        [userId || sessionId],
      );

      const items = await client.query(
        "SELECT * FROM order_items WHERE order_id = $1",
        [newOrder.id],
      );

      return { ...newOrder, items: items.rows };
    });

    res.status(201).json({ order });
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error("Create order error:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// Get user orders
router.get("/", authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 10, 1),
      50,
    );
    const offset = (page - 1) * limit;

    const countResult = await query(
      "SELECT COUNT(*) FROM orders WHERE user_id = $1",
      [userId],
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const ordersResult = await query(
      `SELECT * FROM orders
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    res.json({
      orders: ordersResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get orders error:", error);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// Get order by ID or order number.
// Logged-in owners and admins can always view. Guest orders require the
// order's email as ?email=... to prove ownership.
router.get("/:identifier", optionalAuth, async (req, res) => {
  try {
    const { identifier } = req.params;
    const { email } = req.query;
    const userId = req.user?.id;

    const orderResult = await query(
      "SELECT * FROM orders WHERE id::text = $1 OR order_number = $1",
      [identifier],
    );
    const order = orderResult.rows[0];

    const isAdmin = req.user?.role === "admin";
    const isOwner = Boolean(userId) && order?.user_id === userId;
    const isGuestMatch =
      Boolean(order) &&
      !order.user_id &&
      typeof email === "string" &&
      email.trim().toLowerCase() === order.email.toLowerCase();

    // Return 404 (not 403) so we don't reveal which orders exist
    if (!order || !(isAdmin || isOwner || isGuestMatch)) {
      return res.status(404).json({ error: "Order not found" });
    }

    const itemsResult = await query(
      `SELECT oi.*, p.slug, p.images
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1`,
      [order.id],
    );

    const paymentsResult = await query(
      "SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC",
      [order.id],
    );

    res.json({
      order: {
        ...order,
        items: itemsResult.rows,
        payments: paymentsResult.rows,
      },
    });
  } catch (error) {
    console.error("Get order error:", error);
    res.status(500).json({ error: "Failed to fetch order" });
  }
});

export default router;
