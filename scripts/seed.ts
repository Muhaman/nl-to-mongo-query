import { readFile } from "node:fs/promises";
import { config } from "dotenv";
import { z } from "zod";
import { connectDatabase } from "../src/db.js";

config({ quiet: true });

const env = z
  .object({ MONGODB_URI: z.string().min(1), MONGODB_DB: z.string().min(1).default("movies") })
  .parse(process.env);

const movies: unknown[] = JSON.parse(
  await readFile(new URL("../data/movies.json", import.meta.url), "utf8"),
);

const database = await connectDatabase(env.MONGODB_URI, env.MONGODB_DB);
try {
  const collection = database.db.collection("movies");
  await collection.deleteMany({});
  const { insertedCount } = await collection.insertMany(movies as Record<string, unknown>[]);
  process.stdout.write(`Seeded ${insertedCount} synthetic movies into ${env.MONGODB_DB}.movies\n`);
} finally {
  await database.close();
}
