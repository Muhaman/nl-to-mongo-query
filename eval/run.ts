import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import type { Document } from "mongodb";
import { z } from "zod";
import { connectDatabase } from "../src/db.js";
import { loadEnv } from "../src/env.js";
import { ClaudeLlm } from "../src/query/claude.js";
import { createAnswer, MAX_TIME_MS } from "../src/query/service.js";
import { validatePipeline } from "../src/query/validate.js";

config({ quiet: true });

const questionsSchema = z.array(
  z.object({
    question: z.string(),
    collection: z.string(),
    expectedPipeline: z.array(z.record(z.string(), z.unknown())),
  }),
);

const bsonType = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null ? (value as { _bsontype?: string })._bsontype : undefined;

/** Canonical JSON for comparison: sorted keys, rounded floats, ObjectId `_id`s dropped. */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === "number") return Math.round(value * 1e6) / 1e6;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object" || value === null) return value;
  if (bsonType(value) !== undefined) return String(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(key === "_id" && bsonType(child) === "ObjectId"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, normalise(child)]),
  );
}

function sameResults(expected: Document[], actual: Document[], ordered: boolean): boolean {
  const canon = (docs: Document[]): string[] => docs.map((doc) => JSON.stringify(normalise(doc)));
  const a = canon(expected);
  const b = canon(actual);
  if (!ordered) {
    a.sort();
    b.sort();
  }
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

const env = loadEnv();
const questions = questionsSchema.parse(
  JSON.parse(await readFile(new URL("./questions.json", import.meta.url), "utf8")),
);

const database = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB);
const llm = new ClaudeLlm(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), env.ANTHROPIC_MODEL);
const answer = createAnswer({ db: database.db, llm, allowedCollections: env.allowedCollections });

let passed = 0;
try {
  for (const item of questions) {
    let verdict: string;
    try {
      const expected = validatePipeline(item.expectedPipeline, { allowedCollections: env.allowedCollections });
      if (!expected.ok) throw new Error(`expectedPipeline is invalid: ${expected.errors.join("; ")}`);
      const expectedResults = await database.db
        .collection(item.collection)
        .aggregate(expected.pipeline, { maxTimeMS: MAX_TIME_MS })
        .toArray();

      const actual = await answer({ question: item.question, collection: item.collection });
      const ordered = item.expectedPipeline.some((stage) => "$sort" in stage);
      const ok = sameResults(expectedResults, actual.results, ordered);
      if (ok) passed += 1;
      verdict = ok ? "PASS " : "FAIL ";
    } catch (err) {
      verdict = `ERROR (${(err as Error).message}) `;
    }
    process.stdout.write(`${verdict} ${item.question}\n`);
  }
} finally {
  await database.close();
}

const percent = ((passed / questions.length) * 100).toFixed(1);
process.stdout.write(`\nAccuracy: ${passed}/${questions.length} (${percent}%) with ${env.ANTHROPIC_MODEL}\n`);
