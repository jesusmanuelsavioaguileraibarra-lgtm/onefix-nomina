import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "node:http";
import { registerRoutes } from "./routes";
import { verifyDatabase } from "./pg-storage";
import { ensureContractTrackingSchema } from "./contract-tracking";
import { ensureReceivablesSchema } from "./receivables";
import { ensureReceiptDeliverySchema } from "./receipt-delivery";
import { ensureSalesSchema } from "./sales";

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export async function createApp() {
  await verifyDatabase();
  await ensureContractTrackingSchema();
  await ensureReceivablesSchema();
  await ensureReceiptDeliverySchema();
  await ensureSalesSchema();
  const app = express();
  const httpServer = createServer(app);

  app.use(express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store, private");
    }
    next();
  });

  await registerRoutes(httpServer, app);
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    console.error("Internal Server Error:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ message: "Internal Server Error" });
  });
  return { app, httpServer };
}
