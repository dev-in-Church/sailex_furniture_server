import { Router } from "express";
import { query, withTransaction } from "../config/database.js";
import { optionalAuth } from "../middlewares/auth.js";
import { v4 as uuidv4 } from "uuid";

const router = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

const MAX_QTY = 99;
const parseQuantity = (value) => {
  const qty = Number.parseInt(value, 10);
  return Number.isInteger(qty) && qty >= 1 && qty <= MAX_QTY ? qty : null;
};

// Get cart
router.get("/", optionalAuth, async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    const userId = req.user?.id;

    if (!sessionId && !userId) {
      return res.json({ items: [], total: 0 });
    }

    const ownerCol = userId ? "ci.user_id" : "ci.session_id";
    const result = await query(
      `SELECT ci.*, p.name, p.slug, p.price, p.images, p.stock_quantity
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id AND p.status = 'active'
       WHERE ${ownerCol} = $1
       ORDER BY ci.created_at DESC`,
      [userId || sessionId],
    );

    const items = result.rows.map((item) => ({
      ...item,
      images: item.images || [],
      subtotal: parseFloat(item.price) * item.quantity,
    }));

    const total = items.reduce((sum, item) => sum + item.subtotal, 0);

    res.json({ items, total });
  } catch (error) {
    console.error("Get cart error:", error);
    res.status(500).json({ error: "Failed to fetch cart" });
  }
});

// Add to cart
router.post("/items", optionalAuth, async (req, res) => {
  try {
    const { productId, quantity = 1 } = req.body;
    let sessionId = req.headers["x-session-id"];
    const userId = req.user?.id;

    if (!productId) {
      return res.status(400).json({ error: "Product ID is required" });
    }
    if (!isUuid(productId)) {
      return res.status(404).json({ error: "Product not found" });
    }

    const qty = parseQuantity(quantity);
    if (qty === null) {
      return res
        .status(400)
        .json({
          error: `Quantity must be a whole number between 1 and ${MAX_QTY}`,
        });
    }

    // Create session ID if not provided and user not logged in
    if (!sessionId && !userId) {
      sessionId = uuidv4();
    }

    // Check product exists, is active, and has stock
    const productResult = await query(
      "SELECT id, stock_quantity FROM products WHERE id = $1 AND status = $2",
      [productId, "active"],
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = productResult.rows[0];

    const ownerCol = userId ? "user_id" : "session_id";
    const ownerVal = userId || sessionId;

    // Stock check including what's already in the cart
    const existing = await query(
      `SELECT quantity FROM cart_items WHERE ${ownerCol} = $1 AND product_id = $2`,
      [ownerVal, productId],
    );
    const alreadyInCart = existing.rows[0]?.quantity || 0;

    if (alreadyInCart + qty > product.stock_quantity) {
      return res.status(400).json({ error: "Insufficient stock" });
    }

    // Single upsert: relies on the partial unique indexes uq_cart_user_product
    // and uq_cart_session_product
    const conflictTarget = userId
      ? "(user_id, product_id) WHERE user_id IS NOT NULL"
      : "(session_id, product_id) WHERE user_id IS NULL AND session_id IS NOT NULL";

    const result = await query(
      `INSERT INTO cart_items (${ownerCol}, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT ${conflictTarget}
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity
       RETURNING *`,
      [ownerVal, productId, qty],
    );

    res.status(201).json({
      item: result.rows[0],
      sessionId: sessionId || undefined,
    });
  } catch (error) {
    console.error("Add to cart error:", error);
    res.status(500).json({ error: "Failed to add to cart" });
  }
});

// Update cart item
router.put("/items/:id", optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const sessionId = req.headers["x-session-id"];
    const userId = req.user?.id;

    const qty = parseQuantity(req.body.quantity);
    if (qty === null) {
      return res
        .status(400)
        .json({
          error: `Quantity must be a whole number between 1 and ${MAX_QTY}`,
        });
    }

    if (!isUuid(id)) {
      return res.status(404).json({ error: "Cart item not found" });
    }

    // Get cart item
    const itemResult = await query("SELECT * FROM cart_items WHERE id = $1", [
      id,
    ]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: "Cart item not found" });
    }

    const item = itemResult.rows[0];

    // Verify ownership
    if (userId && item.user_id !== userId) {
      return res.status(403).json({ error: "Not authorized" });
    }
    if (!userId && (!sessionId || item.session_id !== sessionId)) {
      return res.status(403).json({ error: "Not authorized" });
    }

    // Check stock
    const productResult = await query(
      "SELECT stock_quantity FROM products WHERE id = $1 AND status = $2",
      [item.product_id, "active"],
    );
    if (productResult.rows.length === 0) {
      return res.status(404).json({ error: "Product no longer available" });
    }
    if (qty > productResult.rows[0].stock_quantity) {
      return res.status(400).json({ error: "Insufficient stock" });
    }

    const result = await query(
      "UPDATE cart_items SET quantity = $1 WHERE id = $2 RETURNING *",
      [qty, id],
    );

    res.json({ item: result.rows[0] });
  } catch (error) {
    console.error("Update cart item error:", error);
    res.status(500).json({ error: "Failed to update cart item" });
  }
});

// Remove cart item
router.delete("/items/:id", optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const sessionId = req.headers["x-session-id"];
    const userId = req.user?.id;

    if (!isUuid(id)) {
      return res.status(404).json({ error: "Cart item not found" });
    }

    // Get cart item
    const itemResult = await query("SELECT * FROM cart_items WHERE id = $1", [
      id,
    ]);
    if (itemResult.rows.length === 0) {
      return res.status(404).json({ error: "Cart item not found" });
    }

    const item = itemResult.rows[0];

    // Verify ownership
    if (userId && item.user_id !== userId) {
      return res.status(403).json({ error: "Not authorized" });
    }
    if (!userId && (!sessionId || item.session_id !== sessionId)) {
      return res.status(403).json({ error: "Not authorized" });
    }

    await query("DELETE FROM cart_items WHERE id = $1", [id]);

    res.json({ message: "Item removed from cart" });
  } catch (error) {
    console.error("Remove cart item error:", error);
    res.status(500).json({ error: "Failed to remove cart item" });
  }
});

// Clear cart
router.delete("/", optionalAuth, async (req, res) => {
  try {
    const sessionId = req.headers["x-session-id"];
    const userId = req.user?.id;

    if (userId) {
      await query("DELETE FROM cart_items WHERE user_id = $1", [userId]);
    } else if (sessionId) {
      await query("DELETE FROM cart_items WHERE session_id = $1", [sessionId]);
    }

    res.json({ message: "Cart cleared" });
  } catch (error) {
    console.error("Clear cart error:", error);
    res.status(500).json({ error: "Failed to clear cart" });
  }
});

// Merge guest cart with user cart (after login)
router.post("/merge", optionalAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.user?.id;

    if (!userId || !sessionId) {
      return res
        .status(400)
        .json({ error: "User must be logged in and session ID provided" });
    }

    await withTransaction(async (client) => {
      // Copy guest items into the user's cart, clamped to available stock.
      // If the product is already in the user's cart, add quantities (also clamped).
      await client.query(
        `INSERT INTO cart_items (user_id, product_id, quantity)
         SELECT $1::uuid, ci.product_id, LEAST(ci.quantity, p.stock_quantity)
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id AND p.status = 'active'
         WHERE ci.session_id = $2 AND ci.user_id IS NULL AND p.stock_quantity > 0
         ON CONFLICT (user_id, product_id) WHERE user_id IS NOT NULL
         DO UPDATE SET quantity = LEAST(
           cart_items.quantity + EXCLUDED.quantity,
           (SELECT stock_quantity FROM products WHERE id = cart_items.product_id)
         )`,
        [userId, sessionId],
      );

      // Remove the guest rows (including any that couldn't be merged)
      await client.query(
        "DELETE FROM cart_items WHERE session_id = $1 AND user_id IS NULL",
        [sessionId],
      );
    });

    res.json({ message: "Cart merged successfully" });
  } catch (error) {
    console.error("Merge cart error:", error);
    res.status(500).json({ error: "Failed to merge cart" });
  }
});

export default router;
