import pg from "pg";
const { Pool } = pg;

// Local Postgres usually has no SSL; hosted ones (Supabase, Neon, etc.) require it
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client:", err.message);
});

export const query = (text, params) => pool.query(text, params);

/**
 * Runs `fn(client)` inside a transaction. Commits if it resolves,
 * rolls back if it throws. Always use the `client` passed to `fn`
 * (not the pool) for queries that belong to the transaction.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabaseConnection() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Database: DATABASE_URL is not set in .env");
    return false;
  }

  const start = Date.now();
  try {
    const { rows } = await pool.query("SELECT current_database() AS db");
    console.log(
      `✅ Database connected: "${rows[0].db}" (${Date.now() - start}ms)`,
    );
    return true;
  } catch (err) {
    console.error(`❌ Database connection failed: ${err.message}`);
    return false;
  }
}

export default pool;
