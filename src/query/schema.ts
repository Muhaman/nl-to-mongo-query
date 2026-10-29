import type { Db, Document } from "mongodb";

export interface FieldSummary {
  /** Dotted path; array elements are suffixed with `[]`. */
  path: string;
  types: string[];
  examples: unknown[];
}

export interface SchemaSummary {
  collection: string;
  fields: FieldSummary[];
}

const MAX_EXAMPLES = 3;
const MAX_EXAMPLE_CHARS = 60;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (typeof value === "object") {
    return (value as { _bsontype?: string })._bsontype === "ObjectId" ? "objectId" : "object";
  }
  return typeof value;
}

function exampleOf(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, MAX_EXAMPLE_CHARS);
  if (value instanceof Date) return value.toISOString();
  if (typeOf(value) === "objectId") return String(value);
  return value;
}

function visit(path: string, value: unknown, fields: Map<string, FieldSummary>): void {
  const type = typeOf(value);
  let field = fields.get(path);
  if (!field) {
    field = { path, types: [], examples: [] };
    fields.set(path, field);
  }
  if (!field.types.includes(type)) field.types.push(type);

  if (type === "array") {
    for (const item of value as unknown[]) visit(`${path}[]`, item, fields);
  } else if (type === "object") {
    for (const [key, child] of Object.entries(value as Document)) visit(`${path}.${key}`, child, fields);
  } else if (field.examples.length < MAX_EXAMPLES) {
    const example = exampleOf(value);
    if (!field.examples.some((seen) => seen === example)) field.examples.push(example);
  }
}

/** Samples `n` documents and summarises every field path with its observed types and example values. */
export async function sampleSchema(db: Db, collection: string, n = 50): Promise<SchemaSummary> {
  const docs = await db.collection(collection).aggregate([{ $sample: { size: n } }], { maxTimeMS: 5000 }).toArray();
  const fields = new Map<string, FieldSummary>();
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) visit(key, value, fields);
  }
  return { collection, fields: [...fields.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
