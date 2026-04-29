import { Router } from 'express';
import { query } from '../config/database.js';
import { optionalAuth } from '../middlewares/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// Get cart
router.get('/', optionalAuth, async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const userId = req.user?.id;

    if (!sessionId && !userId) {
      return res.json({ items: [], total: 0 });
    }

    let cartQuery;
    let params;

    if (userId) {
      cartQuery = `
        SELECT ci.*, p.name, p.slug, p.price, p.images, p.stock_quantity
        FROM cart_items ci
        JOIN products p ON ci.product_id = p.id
        WHERE ci.user_id = $1
        ORDER BY ci.created_at DESC
      `;
      params = [userId];
    } else {
      cartQuery = `
        SELECT ci.*, p.name, p.slug, p.price, p.images, p.stock_quantity
        FROM cart_items ci
        JOIN products p ON ci.product_id = p.id
        WHERE ci.session_id = $1
        ORDER BY ci.created_at DESC
      `;
      params = [sessionId];
    }

    const result = await query(cartQuery, params);
    
    const items = result.rows.map(item => ({
      ...item,
      images: item.images || [],
      subtotal: parseFloat(item.price) * item.quantity,
    }));

    const total = items.reduce((sum, item) => sum + item.subtotal, 0);

    res.json({ items, total });
  } catch (error) {
    console.error('Get cart error:', error);
    res.status(500).json({ error: 'Failed to fetch cart' });
  }
});

// Add to cart
router.post('/items', optionalAuth, async (req, res) => {
  try {
    const { productId, quantity = 1 } = req.body;
    let sessionId = req.headers['x-session-id'];
    const userId = req.user?.id;

    if (!productId) {
      return res.status(400).json({ error: 'Product ID is required' });
    }

    // Create session ID if not provided and user not logged in
    if (!sessionId && !userId) {
      sessionId = uuidv4();
    }

    // Check product exists and has stock
    const productResult = await query(
      'SELECT id, stock_quantity FROM products WHERE id = $1 AND status = $2',
      [productId, 'active']
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = productResult.rows[0];
    if (product.stock_quantity < quantity) {
      return res.status(400).json({ error: 'Insufficient stock' });
    }

    // Check if item already in cart
    let existingItem;
    if (userId) {
      existingItem = await query(
        'SELECT * FROM cart_items WHERE user_id = $1 AND product_id = $2',
        [userId, productId]
      );
    } else {
      existingItem = await query(
        'SELECT * FROM cart_items WHERE session_id = $1 AND product_id = $2',
        [sessionId, productId]
      );
    }

    let result;
    if (existingItem.rows.length > 0) {
      // Update quantity
      const newQuantity = existingItem.rows[0].quantity + parseInt(quantity);
      if (newQuantity > product.stock_quantity) {
        return res.status(400).json({ error: 'Insufficient stock' });
      }

      result = await query(
        'UPDATE cart_items SET quantity = $1 WHERE id = $2 RETURNING *',
        [newQuantity, existingItem.rows[0].id]
      );
    } else {
      // Add new item
      if (userId) {
        result = await query(
          'INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3) RETURNING *',
          [userId, productId, parseInt(quantity)]
        );
      } else {
        result = await query(
          'INSERT INTO cart_items (session_id, product_id, quantity) VALUES ($1, $2, $3) RETURNING *',
          [sessionId, productId, parseInt(quantity)]
        );
      }
    }

    res.status(201).json({ 
      item: result.rows[0],
      sessionId: sessionId || undefined 
    });
  } catch (error) {
    console.error('Add to cart error:', error);
    res.status(500).json({ error: 'Failed to add to cart' });
  }
});

// Update cart item
router.put('/items/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;
    const sessionId = req.headers['x-session-id'];
    const userId = req.user?.id;

    if (!quantity || quantity < 1) {
      return res.status(400).json({ error: 'Valid quantity is required' });
    }

    // Get cart item
    const itemResult = await query('SELECT * FROM cart_items WHERE id = $1', [id]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cart item not found' });
    }

    const item = itemResult.rows[0];

    // Verify ownership
    if (userId && item.user_id !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (!userId && item.session_id !== sessionId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Check stock
    const productResult = await query('SELECT stock_quantity FROM products WHERE id = $1', [item.product_id]);
    if (quantity > productResult.rows[0].stock_quantity) {
      return res.status(400).json({ error: 'Insufficient stock' });
    }

    const result = await query(
      'UPDATE cart_items SET quantity = $1 WHERE id = $2 RETURNING *',
      [parseInt(quantity), id]
    );

    res.json({ item: result.rows[0] });
  } catch (error) {
    console.error('Update cart item error:', error);
    res.status(500).json({ error: 'Failed to update cart item' });
  }
});

// Remove cart item
router.delete('/items/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const sessionId = req.headers['x-session-id'];
    const userId = req.user?.id;

    // Get cart item
    const itemResult = await query('SELECT * FROM cart_items WHERE id = $1', [id]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cart item not found' });
    }

    const item = itemResult.rows[0];

    // Verify ownership
    if (userId && item.user_id !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (!userId && item.session_id !== sessionId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await query('DELETE FROM cart_items WHERE id = $1', [id]);

    res.json({ message: 'Item removed from cart' });
  } catch (error) {
    console.error('Remove cart item error:', error);
    res.status(500).json({ error: 'Failed to remove cart item' });
  }
});

// Clear cart
router.delete('/', optionalAuth, async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const userId = req.user?.id;

    if (userId) {
      await query('DELETE FROM cart_items WHERE user_id = $1', [userId]);
    } else if (sessionId) {
      await query('DELETE FROM cart_items WHERE session_id = $1', [sessionId]);
    }

    res.json({ message: 'Cart cleared' });
  } catch (error) {
    console.error('Clear cart error:', error);
    res.status(500).json({ error: 'Failed to clear cart' });
  }
});

// Merge guest cart with user cart (after login)
router.post('/merge', optionalAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.user?.id;

    if (!userId || !sessionId) {
      return res.status(400).json({ error: 'User must be logged in and session ID provided' });
    }

    // Get guest cart items
    const guestItems = await query(
      'SELECT * FROM cart_items WHERE session_id = $1',
      [sessionId]
    );

    for (const item of guestItems.rows) {
      // Check if product already in user cart
      const existing = await query(
        'SELECT * FROM cart_items WHERE user_id = $1 AND product_id = $2',
        [userId, item.product_id]
      );

      if (existing.rows.length > 0) {
        // Update quantity
        await query(
          'UPDATE cart_items SET quantity = quantity + $1 WHERE id = $2',
          [item.quantity, existing.rows[0].id]
        );
      } else {
        // Move item to user cart
        await query(
          'UPDATE cart_items SET user_id = $1, session_id = NULL WHERE id = $2',
          [userId, item.id]
        );
      }
    }

    // Delete any remaining guest items
    await query('DELETE FROM cart_items WHERE session_id = $1', [sessionId]);

    res.json({ message: 'Cart merged successfully' });
  } catch (error) {
    console.error('Merge cart error:', error);
    res.status(500).json({ error: 'Failed to merge cart' });
  }
});

export default router;
