import { Router } from "express";
import { query, withTransaction } from "../config/database.js";
import { authenticate, requireAdmin } from "../middlewares/auth.js";
import { restoreOrderStock } from "../jobs/expire-orders.js";

const router = Router();

// Every admin route requires a logged-in admin
router.use(authenticate, requireAdmin);

/* --------------------------------- constants -------------------------------- */

const LOW_STOCK_THRESHOLD = 5;
const MAX_PAGE_SIZE = 100;

const PRODUCT_STATUSES = ["active", "draft", "archived"];
const ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
];
const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"];
const ORDER_FLOW = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
];

// ?sort= options for the product list
const PRODUCT_SORTS = {
  newest: "p.created_at DESC, p.id",
  name: "p.name ASC, p.id",
  "price-asc": "p.price ASC, p.id",
  "price-desc": "p.price DESC, p.id",
  "stock-asc": "p.stock_quantity ASC, p.name ASC",
};

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSONB_COLUMNS = new Set(["images", "specifications"]);

// Customer name for an order: account name, else the delivery name, else the email
const CUSTOMER_NAME_SQL = `COALESCE(
  u.name,
  NULLIF(TRIM(CONCAT_WS(' ', o.shipping_address->>'firstName', o.shipping_address->>'lastName')), ''),
  o.email
)`;

/* ---------------------------------- helpers --------------------------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (message, status = 400) => {
  throw new HttpError(status, message);
};

const asString = (value) => (typeof value === "string" ? value : "");
const isUuid = (value) => typeof value === "string" && UUID_RE.test(value);
const has = (body, key) => Object.hasOwn(body ?? {}, key);

const asPositiveInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

const parseMoney = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100_000_000 ? n : null;
};

const parseWholeNumber = (value, max) => {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};

const slugify = (text) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function pagination(q, defaultLimit = 20) {
  const page = asPositiveInt(q.page, 1);
  const limit = asPositiveInt(q.limit, defaultLimit, MAX_PAGE_SIZE);
  return { page, limit, offset: (page - 1) * limit };
}

const pageMeta = (page, limit, total) => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
});

const pctChange = (current, previous) =>
  previous > 0
    ? Math.round(((current - previous) / previous) * 1000) / 10
    : null;

// Wraps a handler so every route reports errors the same way
const route = (label, handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error.code === "23505") {
      return res
        .status(409)
        .json({ error: "A record with this slug or SKU already exists" });
    }
    if (error.code === "23503") {
      return res
        .status(400)
        .json({ error: "A referenced record does not exist" });
    }
    if (error.code === "22P02") {
      return res.status(400).json({ error: "Invalid ID" });
    }
    console.error(`Admin: failed to ${label}:`, error);
    res.status(500).json({ error: `Failed to ${label}` });
  }
};

// INSERT / UPDATE fragments built only from the fixed column names produced by the parsers below
const columnValue = (column, index) =>
  `$${index}${JSONB_COLUMNS.has(column) ? "::jsonb" : ""}`;

function buildInsert(values) {
  const columns = Object.keys(values);
  return {
    columns: columns.join(", "),
    placeholders: columns.map((c, i) => columnValue(c, i + 1)).join(", "),
    params: Object.values(values),
  };
}

function buildUpdate(values, firstIndex = 1) {
  const columns = Object.keys(values);
  return {
    sets: columns
      .map((c, i) => `${c} = ${columnValue(c, firstIndex + i)}`)
      .join(", "),
    params: Object.values(values),
  };
}

/* ------------------------------- input parsers ------------------------------ */

function parseProductInput(body, { partial }) {
  const values = {};

  if (!partial || has(body, "name")) {
    const name = asString(body.name).trim();
    if (!name || name.length > 200)
      fail("Name is required (max 200 characters)");
    values.name = name;
  }

  if (!partial || has(body, "slug")) {
    let slug = asString(body.slug).trim().toLowerCase();
    if (!slug && !partial) slug = slugify(values.name ?? "");
    if (!SLUG_RE.test(slug)) {
      fail("Slug can only contain lowercase letters, numbers and hyphens");
    }
    values.slug = slug;
  }

  if (!partial || has(body, "price")) {
    const price = parseMoney(body.price);
    if (price === null) fail("A valid price is required");
    values.price = price;
  }

  if (has(body, "compareAtPrice")) {
    if (body.compareAtPrice === null || body.compareAtPrice === "") {
      values.compare_at_price = null;
    } else {
      const compareAt = parseMoney(body.compareAtPrice);
      if (compareAt === null) fail("Compare-at price is not valid");
      values.compare_at_price = compareAt;
    }
  }

  if (has(body, "description")) {
    const description = asString(body.description).trim();
    if (description.length > 10_000) fail("Description is too long");
    values.description = description || null;
  }

  if (has(body, "sku")) {
    const sku = asString(body.sku).trim();
    if (sku.length > 100) fail("SKU is too long");
    values.sku = sku || null; // null, not "", so the unique SKU rule ignores blanks
  }

  if (has(body, "stockQuantity")) {
    const stock = parseWholeNumber(body.stockQuantity, 1_000_000);
    if (stock === null) fail("Stock must be a whole number of 0 or more");
    values.stock_quantity = stock;
  }

  if (has(body, "categoryId")) {
    if (body.categoryId === null || body.categoryId === "") {
      values.category_id = null;
    } else if (isUuid(body.categoryId)) {
      values.category_id = body.categoryId;
    } else {
      fail("Category is not valid");
    }
  }

  if (has(body, "images")) {
    if (!Array.isArray(body.images)) fail("Images must be a list");
    const images = body.images.filter((i) => typeof i === "string" && i.trim());
    if (images.length > 12) fail("A product can have at most 12 images");
    if (images.some((i) => i.length > 2000)) fail("An image link is too long");
    values.images = JSON.stringify(images);
  }

  if (has(body, "specifications")) {
    const specs = body.specifications;
    if (specs === null || typeof specs !== "object" || Array.isArray(specs)) {
      fail("Specifications must be a set of name and value pairs");
    }
    const cleaned = {};
    for (const [key, value] of Object.entries(specs)) {
      if (key.trim() && key.length <= 60)
        cleaned[key.trim()] = String(value).slice(0, 500);
    }
    values.specifications = JSON.stringify(cleaned);
  }

  if (has(body, "featured")) {
    values.featured = body.featured === true || body.featured === "true";
  }

  if (has(body, "status")) {
    if (!PRODUCT_STATUSES.includes(body.status)) fail("Invalid product status");
    values.status = body.status;
  }

  return values;
}

function parseCategoryInput(body, { partial }) {
  const values = {};

  if (!partial || has(body, "name")) {
    const name = asString(body.name).trim();
    if (!name || name.length > 100)
      fail("Name is required (max 100 characters)");
    values.name = name;
  }

  if (!partial || has(body, "slug")) {
    let slug = asString(body.slug).trim().toLowerCase();
    if (!slug && !partial) slug = slugify(values.name ?? "");
    if (!SLUG_RE.test(slug)) {
      fail("Slug can only contain lowercase letters, numbers and hyphens");
    }
    values.slug = slug;
  }

  if (has(body, "description")) {
    const description = asString(body.description).trim();
    if (description.length > 2000) fail("Description is too long");
    values.description = description || null;
  }

  if (has(body, "imageUrl")) {
    const imageUrl = asString(body.imageUrl).trim();
    if (imageUrl.length > 2000) fail("Image link is too long");
    values.image_url = imageUrl || null;
  }

  if (has(body, "parentId")) {
    if (body.parentId === null || body.parentId === "") {
      values.parent_id = null;
    } else if (isUuid(body.parentId)) {
      values.parent_id = body.parentId;
    } else {
      fail("Parent category is not valid");
    }
  }

  if (has(body, "sortOrder")) {
    const sortOrder = parseWholeNumber(body.sortOrder, 10_000);
    if (sortOrder === null) fail("Sort order must be a whole number");
    values.sort_order = sortOrder;
  }

  return values;
}

/* --------------------------------- dashboard -------------------------------- */

router.get(
  "/dashboard",
  route("load the dashboard", async (req, res) => {
    const [
      totals,
      trend,
      byStatus,
      stock,
      customers,
      recentOrders,
      revenueByDay,
      topProducts,
      lowStock,
    ] = await Promise.all([
      query(
        `SELECT COALESCE(SUM(total), 0) AS revenue FROM orders WHERE payment_status = 'paid'`,
      ),
      query(
        `SELECT
           COALESCE(SUM(total) FILTER (WHERE payment_status = 'paid' AND created_at >= now() - interval '30 days'), 0) AS revenue_current,
           COALESCE(SUM(total) FILTER (WHERE payment_status = 'paid' AND created_at <  now() - interval '30 days'), 0) AS revenue_previous,
           COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS orders_current,
           COUNT(*) FILTER (WHERE created_at <  now() - interval '30 days') AS orders_previous
         FROM orders
         WHERE created_at >= now() - interval '60 days'`,
      ),
      query(
        `SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status`,
      ),
      query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE stock_quantity <= $1 AND stock_quantity > 0)::int AS low_stock,
           COUNT(*) FILTER (WHERE stock_quantity <= 0)::int AS out_of_stock
         FROM products WHERE status = 'active'`,
        [LOW_STOCK_THRESHOLD],
      ),
      query(`SELECT COUNT(*)::int AS total FROM users WHERE role = 'customer'`),
      query(
        `SELECT o.id, o.order_number, o.total, o.status, o.payment_status, o.payment_method, o.created_at,
                ${CUSTOMER_NAME_SQL} AS customer_name,
                (SELECT COUNT(*)::int FROM order_items WHERE order_id = o.id) AS item_count
         FROM orders o
         LEFT JOIN users u ON o.user_id = u.id
         ORDER BY o.created_at DESC
         LIMIT 5`,
      ),
      // Last 30 days in Kenyan time, with zero-revenue days included
      query(
        `SELECT to_char(d, 'YYYY-MM-DD') AS date,
                COALESCE(SUM(o.total), 0) AS revenue,
                COUNT(o.id)::int AS orders
         FROM generate_series(
                (now() AT TIME ZONE 'Africa/Nairobi')::date - 29,
                (now() AT TIME ZONE 'Africa/Nairobi')::date,
                interval '1 day') AS d
         LEFT JOIN orders o
           ON o.payment_status = 'paid'
          AND (o.created_at AT TIME ZONE 'Africa/Nairobi')::date = d::date
         GROUP BY d
         ORDER BY d`,
      ),
      query(
        `SELECT p.id, p.name, p.slug, p.images,
                SUM(oi.quantity)::int AS total_sold,
                SUM(oi.price * oi.quantity) AS revenue
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         JOIN orders o ON oi.order_id = o.id
         WHERE o.payment_status = 'paid'
         GROUP BY p.id, p.name, p.slug, p.images
         ORDER BY total_sold DESC
         LIMIT 5`,
      ),
      query(
        `SELECT id, name, slug, stock_quantity AS stock
         FROM products
         WHERE stock_quantity <= $1 AND status = 'active'
         ORDER BY stock_quantity ASC, name
         LIMIT 5`,
        [LOW_STOCK_THRESHOLD],
      ),
    ]);

    const t = trend.rows[0];
    const orders = { total: 0 };
    for (const row of byStatus.rows) {
      orders[row.status] = row.count;
      orders.total += row.count;
    }

    res.json({
      revenue: Number(totals.rows[0].revenue),
      revenueChange: pctChange(
        Number(t.revenue_current),
        Number(t.revenue_previous),
      ),
      ordersChange: pctChange(
        Number(t.orders_current),
        Number(t.orders_previous),
      ),
      orders,
      products: {
        total: stock.rows[0].total,
        lowStock: stock.rows[0].low_stock,
        outOfStock: stock.rows[0].out_of_stock,
      },
      customers: customers.rows[0].total,
      recentOrders: recentOrders.rows,
      revenueByDay: revenueByDay.rows,
      topProducts: topProducts.rows,
      lowStockProducts: lowStock.rows,
    });
  }),
);

/* --------------------------------- products --------------------------------- */

router.get(
  "/products",
  route("fetch products", async (req, res) => {
    const { page, limit, offset } = pagination(req.query);
    const params = [];
    const where = [];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    const status = asString(req.query.status);
    if (PRODUCT_STATUSES.includes(status))
      where.push(`p.status = ${bind(status)}`);

    const categoryId = asString(req.query.category);
    if (isUuid(categoryId)) where.push(`p.category_id = ${bind(categoryId)}`);

    // Same meaning as the dashboard: active products that are running low or out
    if (req.query.lowStock === "true") {
      where.push(
        `(p.status = 'active' AND p.stock_quantity <= ${bind(LOW_STOCK_THRESHOLD)})`,
      );
    }

    const search = asString(req.query.search).trim();
    if (search) {
      const like = bind(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(
        `(p.name ILIKE ${like} OR p.sku ILIKE ${like} OR p.slug ILIKE ${like})`,
      );
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sortKey = asString(req.query.sort);
    const orderBy = Object.hasOwn(PRODUCT_SORTS, sortKey)
      ? PRODUCT_SORTS[sortKey]
      : PRODUCT_SORTS.newest;

    const [count, products, tabCounts] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS count FROM products p ${whereClause}`,
        params,
      ),
      query(
        `SELECT p.*, c.name AS category_name
         FROM products p
         LEFT JOIN categories c ON p.category_id = c.id
         ${whereClause}
         ORDER BY ${orderBy}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      // Totals for the status tabs (they ignore the current search and filters)
      query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'draft')::int AS draft,
                COUNT(*) FILTER (WHERE status = 'archived')::int AS archived,
                COUNT(*) FILTER (WHERE status = 'active' AND stock_quantity <= $1)::int AS low_stock
         FROM products`,
        [LOW_STOCK_THRESHOLD],
      ),
    ]);

    const t = tabCounts.rows[0];
    res.json({
      products: products.rows,
      pagination: pageMeta(page, limit, count.rows[0].count),
      counts: {
        total: t.total,
        active: t.active,
        draft: t.draft,
        archived: t.archived,
        lowStock: t.low_stock,
      },
    });
  }),
);

router.get(
  "/products/:id",
  route("fetch the product", async (req, res) => {
    if (!isUuid(req.params.id)) fail("Product not found", 404);

    const result = await query(
      `SELECT p.*, c.name AS category_name
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = $1`,
      [req.params.id],
    );
    if (result.rows.length === 0) fail("Product not found", 404);

    res.json({ product: result.rows[0] });
  }),
);

router.post(
  "/products",
  route("create the product", async (req, res) => {
    const values = parseProductInput(req.body ?? {}, { partial: false });

    if (
      values.compare_at_price != null &&
      values.compare_at_price <= values.price
    ) {
      fail("Compare-at price must be higher than the price");
    }

    const { columns, placeholders, params } = buildInsert(values);
    const result = await query(
      `INSERT INTO products (${columns}) VALUES (${placeholders}) RETURNING *`,
      params,
    );

    res.status(201).json({ product: result.rows[0] });
  }),
);

// Only the fields you send are changed; send null to clear an optional field
router.put(
  "/products/:id",
  route("update the product", async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) fail("Product not found", 404);

    const values = parseProductInput(req.body ?? {}, { partial: true });
    if (Object.keys(values).length === 0) fail("There is nothing to update");

    const current = (
      await query(
        "SELECT price, compare_at_price FROM products WHERE id = $1",
        [id],
      )
    ).rows[0];
    if (!current) fail("Product not found", 404);

    const price = values.price ?? Number(current.price);
    const compareAt = Object.hasOwn(values, "compare_at_price")
      ? values.compare_at_price
      : current.compare_at_price === null
        ? null
        : Number(current.compare_at_price);
    if (compareAt !== null && compareAt <= price) {
      fail("Compare-at price must be higher than the price");
    }

    const { sets, params } = buildUpdate(values);
    const result = await query(
      `UPDATE products SET ${sets} WHERE id = $${params.length + 1} RETURNING *`,
      [...params, id],
    );

    res.json({ product: result.rows[0] });
  }),
);

// Products that appear in past orders are archived, never deleted, so order history stays intact
router.delete(
  "/products/:id",
  route("delete the product", async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) fail("Product not found", 404);

    const outcome = await withTransaction(async (client) => {
      const product = (
        await client.query("SELECT id FROM products WHERE id = $1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!product) fail("Product not found", 404);

      await client.query("DELETE FROM cart_items WHERE product_id = $1", [id]);

      const ordered = await client.query(
        "SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1",
        [id],
      );
      if (ordered.rowCount > 0) {
        await client.query(
          "UPDATE products SET status = 'archived', featured = false WHERE id = $1",
          [id],
        );
        return "archived";
      }

      await client.query("DELETE FROM reviews WHERE product_id = $1", [id]);
      await client.query("DELETE FROM products WHERE id = $1", [id]);
      return "deleted";
    });

    res.json({
      archived: outcome === "archived",
      message:
        outcome === "archived"
          ? "This product appears in past orders, so it was archived instead of deleted."
          : "Product deleted successfully",
    });
  }),
);

/* -------------------------------- categories -------------------------------- */

router.get(
  "/categories",
  route("fetch categories", async (req, res) => {
    const result = await query(
      `SELECT c.*,
              pc.name AS parent_name,
              (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id) AS product_count,
              (SELECT COUNT(*)::int FROM categories ch WHERE ch.parent_id = c.id) AS children_count
       FROM categories c
       LEFT JOIN categories pc ON c.parent_id = pc.id
       ORDER BY c.sort_order, c.name`,
    );

    res.json({ categories: result.rows });
  }),
);

router.post(
  "/categories",
  route("create the category", async (req, res) => {
    const values = parseCategoryInput(req.body ?? {}, { partial: false });

    const { columns, placeholders, params } = buildInsert(values);
    const result = await query(
      `INSERT INTO categories (${columns}) VALUES (${placeholders}) RETURNING *`,
      params,
    );

    res.status(201).json({ category: result.rows[0] });
  }),
);

router.put(
  "/categories/:id",
  route("update the category", async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) fail("Category not found", 404);

    const values = parseCategoryInput(req.body ?? {}, { partial: true });
    if (Object.keys(values).length === 0) fail("There is nothing to update");

    // A category can't become its own parent or sit under one of its descendants
    if (values.parent_id) {
      if (values.parent_id === id) fail("A category can't be its own parent");
      const cycle = await query(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM categories WHERE parent_id = $1
           UNION
           SELECT c.id FROM categories c JOIN descendants d ON c.parent_id = d.id
         )
         SELECT 1 FROM descendants WHERE id = $2`,
        [id, values.parent_id],
      );
      if (cycle.rowCount > 0)
        fail("A category can't be moved under one of its own subcategories");
    }

    const { sets, params } = buildUpdate(values);
    const result = await query(
      `UPDATE categories SET ${sets} WHERE id = $${params.length + 1} RETURNING *`,
      [...params, id],
    );
    if (result.rows.length === 0) fail("Category not found", 404);

    res.json({ category: result.rows[0] });
  }),
);

router.delete(
  "/categories/:id",
  route("delete the category", async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) fail("Category not found", 404);

    const [products, children] = await Promise.all([
      query(
        "SELECT COUNT(*)::int AS count FROM products WHERE category_id = $1",
        [id],
      ),
      query(
        "SELECT COUNT(*)::int AS count FROM categories WHERE parent_id = $1",
        [id],
      ),
    ]);
    if (products.rows[0].count > 0)
      fail("Move or delete this category's products first");
    if (children.rows[0].count > 0)
      fail("Move or delete this category's subcategories first");

    const result = await query("DELETE FROM categories WHERE id = $1", [id]);
    if (result.rowCount === 0) fail("Category not found", 404);

    res.json({ message: "Category deleted successfully" });
  }),
);

/* ---------------------------------- orders ---------------------------------- */

router.get(
  "/orders",
  route("fetch orders", async (req, res) => {
    const { page, limit, offset } = pagination(req.query);
    const params = [];
    const where = [];
    const bind = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    const status = asString(req.query.status);
    if (ORDER_STATUSES.includes(status))
      where.push(`o.status = ${bind(status)}`);

    const paymentStatus = asString(req.query.paymentStatus);
    if (PAYMENT_STATUSES.includes(paymentStatus)) {
      where.push(`o.payment_status = ${bind(paymentStatus)}`);
    }

    const search = asString(req.query.search).trim();
    if (search) {
      const like = bind(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(
        `(o.order_number ILIKE ${like} OR o.email ILIKE ${like} OR o.phone ILIKE ${like} OR ${CUSTOMER_NAME_SQL} ILIKE ${like})`,
      );
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const fromClause = `FROM orders o LEFT JOIN users u ON o.user_id = u.id`;

    const [count, orders] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS count ${fromClause} ${whereClause}`,
        params,
      ),
      query(
        `SELECT o.*, ${CUSTOMER_NAME_SQL} AS customer_name,
                (SELECT COUNT(*)::int FROM order_items WHERE order_id = o.id) AS item_count
         ${fromClause}
         ${whereClause}
         ORDER BY o.created_at DESC, o.id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
    ]);

    res.json({
      orders: orders.rows,
      pagination: pageMeta(page, limit, count.rows[0].count),
    });
  }),
);

router.get(
  "/orders/:id",
  route("fetch the order", async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) fail("Order not found", 404);

    const orderResult = await query(
      `SELECT o.*, ${CUSTOMER_NAME_SQL} AS customer_name, u.email AS customer_email
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       WHERE o.id = $1`,
      [id],
    );
    if (orderResult.rows.length === 0) fail("Order not found", 404);

    const [items, payments] = await Promise.all([
      query(
        `SELECT oi.*, p.slug, p.images
         FROM order_items oi
         LEFT JOIN products p ON oi.product_id = p.id
         WHERE oi.order_id = $1`,
        [id],
      ),
      query(
        "SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC",
        [id],
      ),
    ]);

    res.json({
      order: {
        ...orderResult.rows[0],
        items: items.rows,
        payments: payments.rows,
      },
    });
  }),
);

// Orders move forward through the flow; they can be cancelled until they ship
function canTransition(from, to) {
  if (from === to) return false;
  if (to === "cancelled")
    return ["pending", "confirmed", "processing"].includes(from);
  const fromIndex = ORDER_FLOW.indexOf(from);
  const toIndex = ORDER_FLOW.indexOf(to);
  return fromIndex !== -1 && toIndex > fromIndex;
}

router.put(
  "/orders/:id/status",
  route("update the order status", async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) fail("Order not found", 404);

    const status = asString(req.body?.status);
    const force = req.body?.force === true;
    if (!ORDER_STATUSES.includes(status)) fail("Invalid status");

    const order = await withTransaction(async (client) => {
      const current = (
        await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!current) fail("Order not found", 404);

      if (!canTransition(current.status, status)) {
        fail(
          `An order that is ${current.status} can't be changed to ${status}`,
          409,
        );
      }

      // Moving past "pending" needs a recorded payment, unless the admin confirms it was paid elsewhere
      const needsPayment = status !== "pending" && status !== "cancelled";
      let note = null;
      if (needsPayment && current.payment_status !== "paid") {
        if (!force) fail("This order has not been paid yet", 409);
        note = `Status set to ${status} without a recorded payment (by ${req.user.email})`;
      }

      if (status === "cancelled") {
        await restoreOrderStock(client, id);
        await client.query(
          `UPDATE payments
           SET status = 'failed',
               metadata = COALESCE(metadata, '{}'::jsonb) || '{"cancelled": true}'::jsonb
           WHERE order_id = $1 AND status = 'pending'`,
          [id],
        );
        if (current.payment_status === "paid") {
          note = `Cancelled after payment: refund needed (by ${req.user.email})`;
        }
      }

      const updated = await client.query(
        `UPDATE orders
         SET status = $2,
             notes = CASE WHEN $3::text IS NULL THEN notes ELSE CONCAT_WS(chr(10), notes, $3::text) END
         WHERE id = $1
         RETURNING *`,
        [id, status, note],
      );
      return updated.rows[0];
    });

    res.json({ order });
  }),
);

// After a cancelled, paid order has been refunded outside the system
router.post(
  "/orders/:id/refunded",
  route("mark the order refunded", async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) fail("Order not found", 404);

    const order = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE orders SET payment_status = 'refunded'
         WHERE id = $1 AND status = 'cancelled' AND payment_status = 'paid'
         RETURNING *`,
        [id],
      );
      if (updated.rowCount === 0) {
        fail(
          "Only cancelled orders that were paid can be marked as refunded",
          409,
        );
      }
      await client.query(
        "UPDATE payments SET status = 'refunded' WHERE order_id = $1 AND status = 'completed'",
        [id],
      );
      return updated.rows[0];
    });

    res.json({ order });
  }),
);

/* --------------------------------- customers -------------------------------- */

router.get(
  "/customers",
  route("fetch customers", async (req, res) => {
    const { page, limit, offset } = pagination(req.query);
    const params = [];
    const where = ["u.role = 'customer'"];

    const search = asString(req.query.search).trim();
    if (search) {
      params.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`(u.name ILIKE $1 OR u.email ILIKE $1 OR u.phone ILIKE $1)`);
    }
    const whereClause = `WHERE ${where.join(" AND ")}`;

    const [count, customers] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS count FROM users u ${whereClause}`,
        params,
      ),
      query(
        `SELECT u.id, u.email, u.name, u.phone, u.created_at,
                (SELECT COUNT(*)::int FROM orders WHERE user_id = u.id) AS order_count,
                (SELECT COALESCE(SUM(total), 0) FROM orders WHERE user_id = u.id AND payment_status = 'paid') AS total_spent,
                (SELECT MAX(created_at) FROM orders WHERE user_id = u.id) AS last_order_at
         FROM users u
         ${whereClause}
         ORDER BY u.created_at DESC, u.id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
    ]);

    res.json({
      customers: customers.rows,
      pagination: pageMeta(page, limit, count.rows[0].count),
    });
  }),
);

/* --------------------------------- inventory -------------------------------- */

router.get(
  "/inventory",
  route("fetch inventory", async (req, res) => {
    const params = [];
    let whereClause = "WHERE status = 'active'";

    if (req.query.lowStock === "true") {
      const threshold = asPositiveInt(
        req.query.threshold,
        LOW_STOCK_THRESHOLD,
        10_000,
      );
      params.push(threshold);
      whereClause += ` AND stock_quantity <= $1`;
    }

    const result = await query(
      `SELECT id, name, slug, sku, stock_quantity, images
       FROM products
       ${whereClause}
       ORDER BY stock_quantity ASC, name`,
      params,
    );

    res.json({ products: result.rows });
  }),
);

router.put(
  "/inventory/:id",
  route("update inventory", async (req, res) => {
    const { id } = req.params;
    if (!isUuid(id)) fail("Product not found", 404);

    const stockQuantity = parseWholeNumber(req.body?.stockQuantity, 1_000_000);
    if (stockQuantity === null)
      fail("Stock must be a whole number of 0 or more");

    const result = await query(
      "UPDATE products SET stock_quantity = $1 WHERE id = $2 RETURNING id, name, stock_quantity",
      [stockQuantity, id],
    );
    if (result.rows.length === 0) fail("Product not found", 404);

    res.json({ product: result.rows[0] });
  }),
);

export default router;
