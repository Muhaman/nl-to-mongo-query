import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { connectDatabase } from "./db.js";
import { loadEnv } from "./env.js";
import { ClaudeLlm } from "./query/claude.js";
import { createAnswer, QueryRejectedError } from "./query/service.js";

config({ quiet: true });

const { values, positionals } = parseArgs({
  options: { collection: { type: "string", short: "c" } },
  allowPositionals: true,
});
const collection = values.collection ?? "movies";
const question = positionals.join(" ").trim();
if (question.length < 3) {
  process.stderr.write('usage: npm run cli -- [--collection movies] "your question"\n');
  process.exit(2);
}

const env = loadEnv();
if (!env.allowedCollections.includes(collection)) {
  process.stderr.write(`collection "${collection}" is not in ALLOWED_COLLECTIONS\n`);
  process.exit(2);
}

const database = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB);
try {
  const llm = new ClaudeLlm(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), env.ANTHROPIC_MODEL);
  const answer = createAnswer({ db: database.db, llm, allowedCollections: env.allowedCollections });
  const out = await answer({ question, collection });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} catch (err) {
  if (err instanceof QueryRejectedError) {
    process.stderr.write(`rejected:\n${err.errors.map((e) => `  - ${e}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  await database.close();
}
