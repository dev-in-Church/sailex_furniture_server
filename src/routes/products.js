import { Router } from 'express';
import { query } from '../config/database.js';

const router = Router();

// Get all products with pagination and filters
router.get('/', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 12, 
      category, 
      search, 
      sort = 'created_at', 
      order = 'desc',
      featured,
      minPrice,
      maxPrice 
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let whereClause = "WHERE p.status = 'active'";
    let paramIndex = 1;

    if (category) {
      whereClause += ` AND (c.slug = $${paramIndex} OR c.parent_id = (SELECT id FROM categories WHERE slug = $${paramIndex}))`;
      params.push(category);
      paramIndex++;
    }

    if (search) {
      whereClause += ` AND (p.name ILIKE $${paramIndex} OR p.description ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (featured === 'true') {
      whereClause += ' AND p.featured = true';
    }

    if (minPrice) {
      whereClause += ` AND p.price >= $${paramIndex}`;
      params.push(parseFloat(minPrice));
      paramIndex++;
    }

    if (maxPrice) {
      whereClause += ` AND p.price <= $${paramIndex}`;
      params.push(parseFloat(maxPrice));
      paramIndex++;
    }

    const validSortFields = ['created_at', 'price', 'name'];
    const sortField = validSortFields.includes(sort) ? sort : 'created_at';
    const sortOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Get products
    const productsResult = await query(
      `SELECT p.*, c.name as category_name, c.slug as category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       ${whereClause}
       ORDER BY p.${sortField} ${sortOrder}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, parseInt(limit), offset]
    );

    res.json({
      products: productsResult.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Get featured products
router.get('/featured', async (req, res) => {
  try {
    const { limit = 6 } = req.query;
    
    const result = await query(
      `SELECT p.*, c.name as category_name, c.slug as category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.status = 'active' AND p.featured = true
       ORDER BY p.created_at DESC
       LIMIT $1`,
      [parseInt(limit)]
    );

    res.json({ products: result.rows });
  } catch (error) {
    console.error('Get featured products error:', error);
    res.status(500).json({ error: 'Failed to fetch featured products' });
  }
});

// Get single product by slug
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const result = await query(
      `SELECT p.*, c.name as category_name, c.slug as category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.slug = $1 AND p.status = 'active'`,
      [slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Get related products
    const product = result.rows[0];
    const relatedResult = await query(
      `SELECT p.*, c.name as category_name, c.slug as category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.category_id = $1 AND p.id != $2 AND p.status = 'active'
       LIMIT 4`,
      [product.category_id, product.id]
    );

    res.json({ 
      product, 
      relatedProducts: relatedResult.rows 
    });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

export default router;
