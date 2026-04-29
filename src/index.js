import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import authRoutes from "./routes/auth.js";
import productsRoutes from "./routes/products.js";
import categoriesRoutes from "./routes/categories.js";
import cartRoutes from "./routes/cart.js";
import ordersRoutes from "./routes/orders.js";
import paymentsRoutes from "./routes/payments.js";
import adminRoutes from "./routes/admin.js";

const app = express();
const PORT = process.env.PORT || 5000;

// Security + logging
app.use(helmet());
app.use(morgan("dev"));

// CORS
const allowedOrigins = [
  "http://localhost:3000",
  process.env.FRONTEND_URL,
  "http://localhost:3001",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

// Stripe webhook
app.use(
  "/api/payments/stripe/webhook",
  express.raw({ type: "application/json" }),
);

// JSON parser
app.use(express.json());

// Root route
app.get("/", (req, res) => {
  res.send("Sailex Furniture API is running ");
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api/admin", adminRoutes);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Error handling
app.use((err, req, res, next) => {
  console.error("Server error:", err);

  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
