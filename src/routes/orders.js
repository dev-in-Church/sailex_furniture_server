import { Router } from 'express';
import { query } from '../config/database.js';
import { authenticate, optionalAuth } from '../middlewares/auth.js';

const router = Router();

// Generate order number
const generateOrderNumber = () => {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SLX-${timestamp}-${random}`;
};

// Create order
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { 
      email, 
      phone, 
      shippingAddress, 
      billingAddress,
      paymentMethod,
      notes 
    } = req.body;

    const sessionId = req.headers['x-session-id'];
    const userId = req.user?.id;

    if (!email || !shippingAddress) {
      return res.status(400).json({ error: 'Email and shipping address are required' });
    }

    if (!paymentMethod || !['mpesa', 'stripe'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Valid payment method is required' });
    }

    // Get cart items
    let cartQuery;
    let cartParams;

    if (userId) {
      cartQuery = `
        SELECT ci.*, p.name, p.price, p.stock_quantity
        FROM cart_items ci
        JOIN products p ON ci.product_id = p.id
        WHERE ci.user_id = $1
      `;
      cartParams = [userId];
    } else if (sessionId) {
      cartQuery = `
        SELECT ci.*, p.name, p.price, p.stock_quantity
        FROM cart_items ci
        JOIN products p ON ci.product_id = p.id
        WHERE ci.session_id = $1
      `;
      cartParams = [sessionId];
    } else {
      return res.status(400).json({ error: 'No cart found' });
    }

    const cartResult = await query(cartQuery, cartParams);
    
    if (cartResult.rows.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Validate stock
    for (const item of cartResult.rows) {
      if (item.quantity > item.stock_quantity) {
        return res.status(400).json({ 
          error: `Insufficient stock for ${item.name}. Available: ${item.stock_quantity}` 
        });
      }
    }

    // Calculate totals
    const subtotal = cartResult.rows.reduce(
      (sum, item) => sum + (parseFloat(item.price) * item.quantity), 
      0
    );
    const shippingCost = subtotal >= 50000 ? 0 : 500; // Free shipping over 50,000
    const tax = 0; // Could calculate VAT here
    const total = subtotal + shippingCost + tax;

    // Create order
    const orderResult = await query(
      `INSERT INTO orders (
        order_number, user_id, email, phone, shipping_address, billing_address,
        subtotal, shipping_cost, tax, total, status, payment_method, payment_status, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        generateOrderNumber(),
        userId || null,
        email,
        phone || null,
        JSON.stringify(shippingAddress),
        billingAddress ? JSON.stringify(billingAddress) : null,
        subtotal,
        shippingCost,
        tax,
        total,
        'pending',
        paymentMethod,
        'pending',
        notes || null
      ]
    );

    const order = orderResult.rows[0];

    // Create order items
    for (const item of cartResult.rows) {
      await query(
        `INSERT INTO order_items (order_id, product_id, name, price, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [order.id, item.product_id, item.name, item.price, item.quantity]
      );

      // Update stock
      await query(
        'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    // Clear cart
    if (userId) {
      await query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
    } else {
      await query('DELETE FROM cart_items WHERE session_id = $1', [sessionId]);
    }

    // Get order items
    const itemsResult = await query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [order.id]
    );

    res.status(201).json({ 
      order: {
        ...order,
        items: itemsResult.rows
      }
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Get user orders
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countResult = await query(
      'SELECT COUNT(*) FROM orders WHERE user_id = $1',
      [userId]
    );
    const total = parseInt(countResult.rows[0].count);

    const ordersResult = await query(
      `SELECT * FROM orders 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), offset]
    );

    res.json({
      orders: ordersResult.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get order by ID or order number
router.get('/:identifier', optionalAuth, async (req, res) => {
  try {
    const { identifier } = req.params;
    const userId = req.user?.id;

    // Try to find by ID or order number
    let orderResult = await query(
      'SELECT * FROM orders WHERE id = $1 OR order_number = $1',
      [identifier]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // If user is logged in, verify ownership (unless admin)
    if (userId && req.user.role !== 'admin' && order.user_id && order.user_id !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Get order items
    const itemsResult = await query(
      `SELECT oi.*, p.slug, p.images 
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1`,
      [order.id]
    );

    // Get payment info
    const paymentsResult = await query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC',
      [order.id]
    );

    res.json({
      order: {
        ...order,
        items: itemsResult.rows,
        payments: paymentsResult.rows,
      },
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

export default router;
