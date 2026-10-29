import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { errorHandler } from "./errors.js";
import type { Logger } from "./logger.js";
import type { Answer } from "./query/service.js";
import { queryRouter } from "./routes/query.js";

export interface AppDeps {
  answer: Answer;
  allowedCollections: string[];
  corsOrigins: string[];
  logger: Logger;
  /** Requests per minute per client. Defaults to 30. */
  rateLimitPerMinute?: number;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    const incoming = req.header("x-request-id");
    const requestId = incoming && incoming.length <= 128 ? incoming : randomUUID();
    res.setHeader("x-request-id", requestId);
    const startedAt = Date.now();
    res.on("finish", () => {
      deps.logger.info(
        { requestId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - startedAt },
        "request",
      );
    });
    next();
  });

  app.use(helmet());
  app.use(cors({ origin: deps.corsOrigins }));
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Every query costs an LLM call, so the limit is deliberately tight.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: deps.rateLimitPerMinute ?? 30,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ error: { code: "rate_limited", message: "Too many requests." } });
      },
    }),
  );

  app.use("/v1/query", express.json({ limit: "10kb" }), queryRouter(deps));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Route not found." } });
  });
  app.use(errorHandler(deps.logger));
  return app;
}
