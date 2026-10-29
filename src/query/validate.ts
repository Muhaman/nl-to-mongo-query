import type { Document } from "mongodb";

export interface ValidateOptions {
  allowedCollections: string[];
  /** Upper bound on returned documents. Defaults to 100. */
  maxLimit?: number;
}

export type ValidationResult = { ok: true; pipeline: Document[] } | { ok: false; errors: string[] };

export const DEFAULT_MAX_LIMIT = 100;

export const ALLOWED_STAGES = [
  "$match",
  "$group",
  "$sort",
  "$project",
  "$limit",
  "$skip",
  "$unwind",
  "$count",
  "$addFields",
  "$set",
  "$lookup",
] as const;

export const DENIED_OPERATORS = ["$where", "$function", "$accumulator", "$out", "$merge"] as const;

const allowedStages = new Set<string>(ALLOWED_STAGES);
const deniedOperators = new Set<string>(DENIED_OPERATORS);

function isPlainObject(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reports every denied operator used as a key anywhere inside `value`. */
function scanOperators(value: unknown, where: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanOperators(item, `${where}[${i}]`, errors));
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (deniedOperators.has(key)) errors.push(`${where}: operator ${key} is not allowed`);
      scanOperators(child, `${where}.${key}`, errors);
    }
  }
}

interface Context {
  allowedCollections: Set<string>;
  maxLimit: number;
  errors: string[];
}

function checkLookup(spec: unknown, where: string, ctx: Context): void {
  if (!isPlainObject(spec)) {
    ctx.errors.push(`${where}: $lookup must be an object`);
    return;
  }
  const { from, pipeline, ...rest } = spec;
  scanOperators(rest, `${where}.$lookup`, ctx.errors);
  if (typeof from !== "string" || !ctx.allowedCollections.has(from)) {
    ctx.errors.push(`${where}: $lookup from ${JSON.stringify(from)} is not an allowed collection`);
  }
  if (pipeline !== undefined) checkStages(pipeline, `${where}.pipeline`, ctx, false);
}

/** Validates a stage list. Returns the rewritten stages (limits clamped) for the top-level call. */
function checkStages(stages: unknown, where: string, ctx: Context, topLevel: boolean): Document[] {
  if (!Array.isArray(stages)) {
    ctx.errors.push(`${where}: pipeline must be an array of stages`);
    return [];
  }
  const out: Document[] = [];
  stages.forEach((stage, i) => {
    const at = `${where}[${i}]`;
    if (!isPlainObject(stage)) {
      ctx.errors.push(`${at}: stage must be an object`);
      return;
    }
    const keys = Object.keys(stage);
    const name = keys[0];
    if (keys.length !== 1 || name === undefined) {
      ctx.errors.push(`${at}: stage must have exactly one operator key`);
      return;
    }
    if (!allowedStages.has(name)) {
      ctx.errors.push(
        deniedOperators.has(name)
          ? `${at}: operator ${name} is not allowed`
          : `${at}: stage ${name} is not allowed (allowed: ${ALLOWED_STAGES.join(", ")})`,
      );
      return;
    }
    if (name === "$lookup") {
      checkLookup(stage[name], at, ctx);
    } else {
      scanOperators(stage[name], `${at}.${name}`, ctx.errors);
    }

    if (name === "$limit") {
      const limit = stage[name];
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
        ctx.errors.push(`${at}: $limit must be a positive integer`);
        return;
      }
      out.push({ $limit: Math.min(limit, ctx.maxLimit) });
      return;
    }
    out.push(stage);
  });

  if (topLevel && out.at(-1)?.$limit === undefined) out.push({ $limit: ctx.maxLimit });
  return out;
}

/**
 * Checks an LLM-produced pipeline against a stage allowlist and an operator denylist (at any depth,
 * including `$lookup` sub-pipelines). Clamps every `$limit` and guarantees the pipeline ends in one.
 */
export function validatePipeline(p: unknown, o: ValidateOptions): ValidationResult {
  const ctx: Context = {
    allowedCollections: new Set(o.allowedCollections),
    maxLimit: o.maxLimit ?? DEFAULT_MAX_LIMIT,
    errors: [],
  };
  const pipeline = checkStages(p, "pipeline", ctx, true);
  return ctx.errors.length > 0 ? { ok: false, errors: ctx.errors } : { ok: true, pipeline };
}
