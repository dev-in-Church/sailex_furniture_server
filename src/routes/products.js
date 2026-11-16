import { Router } from "express";
import { query } from "../config/database.js";

const router = Router();

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 48;
const MAX_SEARCH_TERMS = 5;

/* ------------------------------- helpers ------------------------------- */

const asString = (value) => (typeof value === "string" ? value : "");

const asPositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

const asPrice = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// Escape LIKE wildcards so a search for "50%" matches literally
const escapeLike = (text) => text.replace(/[\\%_]/g, "\\$&");

// Sort options accepted via ?sort=...
const SORTS = {
  newest: "p.created_at DESC",
  oldest: "p.created_at ASC",
  popular: "p.featured DESC, p.created_at DESC",
  featured: "p.featured DESC, p.created_at DESC",
  "price-asc": "p.price ASC",
  "price-low": "p.price ASC",
  "price-desc": "p.price DESC",
  "price-high": "p.price DESC",
  "name-asc": "p.name ASC",
  "name-desc": "p.name DESC",
  discount: `(CASE WHEN p.compare_at_price > p.price
                    THEN (p.compare_at_price - p.price) / p.compare_at_price
                    ELSE 0 END) DESC`,
};

// Older clients: ?sort=price&order=asc
const LEGACY_SORT_FIELDS = {
  created_at: "p.created_at",
  price: "p.price",
  name: "p.name",
};

function resolveOrderBy(sort, order) {
  const key = sort.replace(/_/g, "-");
  if (Object.hasOwn(SORTS, key)) return SORTS[key];
  if (Object.hasOwn(LEGACY_SORT_FIELDS, sort)) {
    const direction = order.toLowerCase() === "asc" ? "ASC" : "DESC";
    return `${LEGACY_SORT_FIELDS[sort]} ${direction}`;
  }
  return SORTS.newest;
}

/**
 * Builds the WHERE clause shared by the count and list queries.
 * Supported: category, search, featured, sale, inStock, minPrice, maxPrice
 */
function buildProductFilters(q) {
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const conditions = ["p.status = 'active'"];

  // Category and all of its descendants, at any depth
  const category = asString(q.category).trim();
  if (category) {
    const slug = add(category);
    conditions.push(`p.category_id IN (
      WITH RECURSIVE tree AS (
        SELECT id FROM categories WHERE slug = ${slug}
        UNION ALL
        SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id
      )
      SELECT id FROM tree
    )`);
  }

  // Every word must match the name, description or SKU ("grey sofa" == "sofa grey")
  const terms = asString(q.search)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TERMS);
  for (const term of terms) {
    const like = add(`%${escapeLike(term)}%`);
    conditions.push(
      `(p.name ILIKE ${like} OR p.description ILIKE ${like} OR p.sku ILIKE ${like})`,
    );
  }

  if (q.featured === "true") {
    conditions.push("p.featured = true");
  }

  if (q.sale === "true") {
    conditions.push(
      "(p.compare_at_price IS NOT NULL AND p.compare_at_price > p.price)",
    );
  }

  if (q.inStock === "true") {
    conditions.push("p.stock_quantity > 0");
  }

  const minPrice = asPrice(q.minPrice);
  if (minPrice !== null) conditions.push(`p.price >= ${add(minPrice)}`);

  const maxPrice = asPrice(q.maxPrice);
  if (maxPrice !== null) conditions.push(`p.price <= ${add(maxPrice)}`);

  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

/* -------------------------------- routes -------------------------------- */

// Get all products with pagination and filters
router.get("/", async (req, res) => {
  try {
    const page = asPositiveInt(req.query.page, 1);
    const limit = asPositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const offset = (page - 1) * limit;

    const { where, params } = buildProductFilters(req.query);
    const orderBy = resolveOrderBy(
      asString(req.query.sort),
      asString(req.query.order),
    );

    const limitParam = `$${params.length + 1}`;
    const offsetParam = `$${params.length + 2}`;

    // The two queries are independent, so run them together (saves a round trip)
    const [countResult, productsResult] = await Promise.all([
      query(`SELECT COUNT(*) FROM products p ${where}`, params),
      query(
        `SELECT p.*, c.name AS category_name, c.slug AS category_slug
         FROM products p
         LEFT JOIN categories c ON p.category_id = c.id
         ${where}
         ORDER BY ${orderBy}, p.id
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        [...params, limit, offset],
      ),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    res.json({
      products: productsResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get products error:", error);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Get featured products
router.get("/featured", async (req, res) => {
  try {
    const limit = asPositiveInt(req.query.limit, 6, 50);

    const result = await query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.status = 'active' AND p.featured = true
       ORDER BY p.created_at DESC
       LIMIT $1`,
      [limit],
    );

    res.json({ products: result.rows });
  } catch (error) {
    console.error("Get featured products error:", error);
    res.status(500).json({ error: "Failed to fetch featured products" });
  }
});

// Get single product by slug
router.get("/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const result = await query(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.slug = $1 AND p.status = 'active'`,
      [slug],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = result.rows[0];

    // Related products from the same category (newest first, stable order)
    const relatedResult = product.category_id
      ? await query(
          `SELECT p.*, c.name AS category_name, c.slug AS category_slug
           FROM products p
           LEFT JOIN categories c ON p.category_id = c.id
           WHERE p.category_id = $1 AND p.id != $2 AND p.status = 'active'
           ORDER BY p.created_at DESC, p.id
           LIMIT 4`,
          [product.category_id, product.id],
        )
      : { rows: [] };

    res.json({
      product,
      relatedProducts: relatedResult.rows,
    });
  } catch (error) {
    console.error("Get product error:", error);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

export default router;
