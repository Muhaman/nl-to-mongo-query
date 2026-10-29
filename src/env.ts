import { z } from "zod";

const list = (raw: string): string[] =>
  raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const schema = z
  .object({
    ANTHROPIC_API_KEY: z.string().min(1),
    ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-5-5"),
    MONGODB_URI: z.string().min(1),
    MONGODB_DB: z.string().min(1).default("movies"),
    ALLOWED_COLLECTIONS: z.string().default("movies"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    CORS_ORIGINS: z.string().default("http://localhost:5173"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .transform((env) => ({
    ...env,
    allowedCollections: list(env.ALLOWED_COLLECTIONS),
    corsOrigins: list(env.CORS_ORIGINS),
  }));

export type Env = z.output<typeof schema>;

export function loadEnv(src: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(src);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment: ${problems.join("; ")}`);
  }
  return result.data;
}
