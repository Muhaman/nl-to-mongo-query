import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { createApp } from "./app.js";
import { connectDatabase } from "./db.js";
import { loadEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { ClaudeLlm } from "./query/claude.js";
import { createAnswer } from "./query/service.js";

config({ quiet: true });

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

const database = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB);
const llm = new ClaudeLlm(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), env.ANTHROPIC_MODEL);
const answer = createAnswer({ db: database.db, llm, allowedCollections: env.allowedCollections });

const app = createApp({
  answer,
  allowedCollections: env.allowedCollections,
  corsOrigins: env.corsOrigins,
  logger,
});
const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, "server listening"));

function shutdown(): void {
  server.close(() => {
    void database.close().finally(() => process.exit(0));
  });
  server.closeAllConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
