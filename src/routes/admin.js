import { Router } from 'express';
import { query } from '../config/database.js';
import { authenticate, requireAdmin } from '../middlewares/auth.js';
import bcrypt from 'bcrypt';

const router = Router();

// Apply auth middleware to all admin routes
router.use(authenticate, requireAdmin);

// Dashboard stats
router.get('/dashboard', async (req, res) => {
  try {
    // Total revenue
    const revenueResult = await query(
      `SELECT COALESCE(SUM(total), 0) as total_revenue FROM orders WHERE payment_status = 'paid'`
    );

    // Orders count by status
    const ordersResult = await query(
      `SELECT status, COUNT(*) as count FROM orders GROUP BY status`
    );

    // Total products and low stock
    const productsResult = await query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN stock_quantity < 5 THEN 1 ELSE 0 END) as low_stock
       FROM products WHERE status = 'active'`
    );

    // Total customers
    const customersResult = await query(
      `SELECT COUNT(*) as total FROM users WHERE role = 'customer'`
    );

    // Recent orders
    const recentOrdersResult = await query(
      `SELECT o.*, 
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
       FROM orders o
       ORDER BY o.created_at DESC
       LIMIT 5`
    );

    // Revenue by day (last 7 days)
    const revenueByDayResult = await query(
      `SELECT 
        DATE(created_at) as date,
        COALESCE(SUM(total), 0) as revenue,
        COUNT(*) as orders
       FROM orders 
       WHERE payment_status = 'paid' 
         AND created_at >= NOW() - INTERVAL '7 days'
       GROUP BY DATE(created_at)
       ORDER BY date`
    );

    // Top selling products
    const topProductsResult = await query(
      `SELECT p.id, p.name, p.slug, p.images, SUM(oi.quantity) as total_sold
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       JOIN orders o ON oi.order_id = o.id
       WHERE o.payment_status = 'paid'
       GROUP BY p.id, p.name, p.slug, p.images
       ORDER BY total_sold DESC
       LIMIT 5`
    );

    res.json({
      revenue: parseFloat(revenueResult.rows[0].total_revenue),
      orders: ordersResult.rows.reduce((acc, row) => {
        acc[row.status] = parseInt(row.count);
        acc.total = (acc.total || 0) + parseInt(row.count);
        return acc;
      }, {}),
      products: {
        total: parseInt(productsResult.rows[0].total),
        lowStock: parseInt(productsResult.rows[0].low_stock),
      },
      customers: parseInt(customersResult.rows[0].total),
      recentOrders: recentOrdersResult.rows,
      revenueByDay: revenueByDayResult.rows,
      topProducts: topProductsResult.rows,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Products CRUD
router.get('/products', async (req, res) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let whereClause = 'WHERE 1=1';
    let paramIndex = 1;

    if (status) {
      whereClause += ` AND p.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (search) {
      whereClause += ` AND (p.name ILIKE $${paramIndex} OR p.sku ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM products p ${whereClause}`,
      params
    );

    const productsResult = await query(
      `SELECT p.*, c.name as category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ${whereClause}
       ORDER BY p.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      products: productsResult.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

router.post('/products', async (req, res) => {
  try {
    const {
      name, slug, description, price, compareAtPrice, sku,
      stockQuantity, categoryId, images, specifications, featured, status
    } = req.body;

    if (!name || !slug || !price) {
      return res.status(400).json({ error: 'Name, slug, and price are required' });
    }

    const result = await query(
      `INSERT INTO products (
        name, slug, description, price, compare_at_price, sku,
        stock_quantity, category_id, images, specifications, featured, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        name, slug, description || null, price, compareAtPrice || null, sku || null,
        stockQuantity || 0, categoryId || null, JSON.stringify(images || []),
        JSON.stringify(specifications || {}), featured || false, status || 'draft'
      ]
    );

    res.status(201).json({ product: result.rows[0] });
  } catch (error) {
    console.error('Create product error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Product with this slug or SKU already exists' });
    }
    res.status(500).json({ error: 'Failed to create product' });
  }
});

router.put('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, slug, description, price, compareAtPrice, sku,
      stockQuantity, categoryId, images, specifications, featured, status
    } = req.body;

    const result = await query(
      `UPDATE products SET
        name = COALESCE($1, name),
        slug = COALESCE($2, slug),
        description = COALESCE($3, description),
        price = COALESCE($4, price),
        compare_at_price = $5,
        sku = $6,
        stock_quantity = COALESCE($7, stock_quantity),
        category_id = $8,
        images = COALESCE($9, images),
        specifications = COALESCE($10, specifications),
        featured = COALESCE($11, featured),
        status = COALESCE($12, status)
       WHERE id = $13
       RETURNING *`,
      [
        name, slug, description, price, compareAtPrice, sku,
        stockQuantity, categoryId, images ? JSON.stringify(images) : null,
        specifications ? JSON.stringify(specifications) : null, featured, status, id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ product: result.rows[0] });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

router.delete('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Soft delete by setting status to archived
    const result = await query(
      `UPDATE products SET status = 'archived' WHERE id = $1 RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ message: 'Product archived successfully' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// Categories CRUD
router.get('/categories', async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*, 
        pc.name as parent_name,
        (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) as product_count
       FROM categories c
       LEFT JOIN categories pc ON c.parent_id = pc.id
       ORDER BY c.sort_order, c.name`
    );

    res.json({ categories: result.rows });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

router.post('/categories', async (req, res) => {
  try {
    const { name, slug, description, imageUrl, parentId, sortOrder } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: 'Name and slug are required' });
    }

    const result = await query(
      `INSERT INTO categories (name, slug, description, image_url, parent_id, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, slug, description || null, imageUrl || null, parentId || null, sortOrder || 0]
    );

    res.status(201).json({ category: result.rows[0] });
  } catch (error) {
    console.error('Create category error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Category with this slug already exists' });
    }
    res.status(500).json({ error: 'Failed to create category' });
  }
});

router.put('/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, description, imageUrl, parentId, sortOrder } = req.body;

    const result = await query(
      `UPDATE categories SET
        name = COALESCE($1, name),
        slug = COALESCE($2, slug),
        description = $3,
        image_url = $4,
        parent_id = $5,
        sort_order = COALESCE($6, sort_order)
       WHERE id = $7
       RETURNING *`,
      [name, slug, description, imageUrl, parentId, sortOrder, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    res.json({ category: result.rows[0] });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

router.delete('/categories/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check for products in category
    const productsCheck = await query(
      'SELECT COUNT(*) FROM products WHERE category_id = $1',
      [id]
    );

    if (parseInt(productsCheck.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete category with products' });
    }

    await query('DELETE FROM categories WHERE id = $1', [id]);

    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// Orders management
router.get('/orders', async (req, res) => {
  try {
    const { page = 1, limit = 20, status, paymentStatus, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let whereClause = 'WHERE 1=1';
    let paramIndex = 1;

    if (status) {
      whereClause += ` AND o.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (paymentStatus) {
      whereClause += ` AND o.payment_status = $${paramIndex}`;
      params.push(paymentStatus);
      paramIndex++;
    }

    if (search) {
      whereClause += ` AND (o.order_number ILIKE $${paramIndex} OR o.email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM orders o ${whereClause}`,
      params
    );

    const ordersResult = await query(
      `SELECT o.*, 
        u.name as customer_name,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      orders: ordersResult.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const orderResult = await query(
      `SELECT o.*, u.name as customer_name, u.email as customer_email
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.id = $1`,
      [id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const itemsResult = await query(
      `SELECT oi.*, p.slug, p.images
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = $1`,
      [id]
    );

    const paymentsResult = await query(
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC',
      [id]
    );

    res.json({
      order: {
        ...orderResult.rows[0],
        items: itemsResult.rows,
        payments: paymentsResult.rows,
      },
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

router.put('/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await query(
      'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order: result.rows[0] });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Customers management
router.get('/customers', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let whereClause = "WHERE role = 'customer'";
    let paramIndex = 1;

    if (search) {
      whereClause += ` AND (name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM users ${whereClause}`,
      params
    );

    const customersResult = await query(
      `SELECT u.id, u.email, u.name, u.phone, u.created_at,
        (SELECT COUNT(*) FROM orders WHERE user_id = u.id) as order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE user_id = u.id AND payment_status = 'paid') as total_spent
       FROM users u
       ${whereClause}
       ORDER BY u.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      customers: customersResult.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// Inventory
router.get('/inventory', async (req, res) => {
  try {
    const { lowStock } = req.query;

    let whereClause = "WHERE status = 'active'";
    if (lowStock === 'true') {
      whereClause += ' AND stock_quantity < 10';
    }

    const result = await query(
      `SELECT id, name, slug, sku, stock_quantity, images
       FROM products
       ${whereClause}
       ORDER BY stock_quantity ASC`
    );

    res.json({ products: result.rows });
  } catch (error) {
    console.error('Get inventory error:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

router.put('/inventory/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { stockQuantity } = req.body;

    if (stockQuantity === undefined || stockQuantity < 0) {
      return res.status(400).json({ error: 'Valid stock quantity is required' });
    }

    const result = await query(
      'UPDATE products SET stock_quantity = $1 WHERE id = $2 RETURNING id, name, stock_quantity',
      [stockQuantity, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ product: result.rows[0] });
  } catch (error) {
    console.error('Update inventory error:', error);
    res.status(500).json({ error: 'Failed to update inventory' });
  }
});

export default router;
