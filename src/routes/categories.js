import { Router } from 'express';
import { query } from '../config/database.js';

const router = Router();

// Get all categories
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT c.*, 
        (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'active') as product_count,
        pc.name as parent_name
       FROM categories c
       LEFT JOIN categories pc ON c.parent_id = pc.id
       ORDER BY c.sort_order, c.name`
    );

    // Organize into hierarchy
    const categories = result.rows;
    const parentCategories = categories.filter(c => !c.parent_id);
    const childCategories = categories.filter(c => c.parent_id);

    const hierarchy = parentCategories.map(parent => ({
      ...parent,
      children: childCategories.filter(child => child.parent_id === parent.id),
    }));

    res.json({ categories: hierarchy, all: categories });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get category by slug
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    
    const result = await query(
      `SELECT c.*, pc.name as parent_name, pc.slug as parent_slug
       FROM categories c
       LEFT JOIN categories pc ON c.parent_id = pc.id
       WHERE c.slug = $1`,
      [slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const category = result.rows[0];

    // Get subcategories
    const subcategoriesResult = await query(
      'SELECT * FROM categories WHERE parent_id = $1 ORDER BY sort_order, name',
      [category.id]
    );

    res.json({ 
      category, 
      subcategories: subcategoriesResult.rows 
    });
  } catch (error) {
    console.error('Get category error:', error);
    res.status(500).json({ error: 'Failed to fetch category' });
  }
});

// Get products by category
router.get('/:slug/products', async (req, res) => {
  try {
    const { slug } = req.params;
    const { page = 1, limit = 12, sort = 'created_at', order = 'desc' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Get category and its children
    const categoryResult = await query('SELECT id FROM categories WHERE slug = $1', [slug]);
    if (categoryResult.rows.length === 0) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const categoryId = categoryResult.rows[0].id;

    // Get child category IDs
    const childrenResult = await query('SELECT id FROM categories WHERE parent_id = $1', [categoryId]);
    const categoryIds = [categoryId, ...childrenResult.rows.map(r => r.id)];

    const validSortFields = ['created_at', 'price', 'name'];
    const sortField = validSortFields.includes(sort) ? sort : 'created_at';
    const sortOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Get total count
    const countResult = await query(
      `SELECT COUNT(*) FROM products WHERE category_id = ANY($1) AND status = 'active'`,
      [categoryIds]
    );
    const total = parseInt(countResult.rows[0].count);

    // Get products
    const productsResult = await query(
      `SELECT p.*, c.name as category_name, c.slug as category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.category_id = ANY($1) AND p.status = 'active'
       ORDER BY p.${sortField} ${sortOrder}
       LIMIT $2 OFFSET $3`,
      [categoryIds, parseInt(limit), offset]
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
    console.error('Get category products error:', error);
    res.status(500).json({ error: 'Failed to fetch category products' });
  }
});

export default router;
