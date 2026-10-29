import { z } from "zod";
import { AppError } from "../errors.js";
import type { SchemaSummary } from "./schema.js";
import { ALLOWED_STAGES, DENIED_OPERATORS } from "./validate.js";

export interface LlmRequest {
  system: string;
  prompt: string;
}

/** Returns the model's structured reply as JSON text: `{ "pipelineJson": string, "explanation": string }`. */
export interface Llm {
  complete(request: LlmRequest): Promise<string>;
}

export class LlmRefusalError extends AppError {
  constructor(category?: string | null) {
    super(
      502,
      "refusal",
      category ? `The model declined to answer (${category}).` : "The model declined to answer.",
    );
    this.name = "LlmRefusalError";
  }
}

export class LlmTruncatedError extends AppError {
  constructor() {
    super(502, "max_tokens", "The model's answer was cut off before it finished.");
    this.name = "LlmTruncatedError";
  }
}

export class LlmOutputError extends AppError {
  constructor() {
    super(502, "invalid_model_output", "The model returned an unreadable reply.");
    this.name = "LlmOutputError";
  }
}

export interface GenerateInput {
  question: string;
  collection: string;
  schema: SchemaSummary;
  previousErrors?: string[];
}

export interface Generation {
  pipelineJson: string;
  explanation: string;
}

const generationSchema = z.object({ pipelineJson: z.string(), explanation: z.string() });

export const SYSTEM_PROMPT = [
  "You translate questions about a MongoDB collection into a single aggregation pipeline.",
  "Reply with a pipelineJson string holding a JSON array of stages, and a one or two sentence explanation of what the pipeline does.",
  `Use only these stages: ${ALLOWED_STAGES.join(", ")}.`,
  `Never use these operators anywhere: ${DENIED_OPERATORS.join(", ")}.`,
  "Query only the collection you are given and only the fields listed in its schema; do not use $lookup unless the question needs it.",
  "Use strict JSON (double-quoted keys, no comments, no trailing commas, no JavaScript expressions such as new Date()).",
  "The result is capped at 100 documents; add a $sort and a $limit when the question asks for top or bottom results.",
].join("\n");

function formatSchema(schema: SchemaSummary): string {
  if (schema.fields.length === 0) return "(no documents sampled)";
  return schema.fields
    .map((field) => {
      const examples = field.examples.length > 0 ? ` e.g. ${field.examples.map((e) => JSON.stringify(e)).join(", ")}` : "";
      return `- ${field.path}: ${field.types.join(" | ")}${examples}`;
    })
    .join("\n");
}

export function buildPrompt(i: GenerateInput): string {
  const parts = [
    `Collection: ${i.collection}`,
    `Schema, sampled from the collection:\n${formatSchema(i.schema)}`,
    `Question: ${i.question}`,
  ];
  if (i.previousErrors && i.previousErrors.length > 0) {
    parts.push(
      `Your previous pipeline was rejected for these reasons:\n${i.previousErrors.map((e) => `- ${e}`).join("\n")}\nReturn a corrected pipeline that avoids them.`,
    );
  }
  return parts.join("\n\n");
}

export async function generatePipeline(llm: Llm, i: GenerateInput): Promise<Generation> {
  const raw = await llm.complete({ system: SYSTEM_PROMPT, prompt: buildPrompt(i) });
  let reply: unknown;
  try {
    reply = JSON.parse(raw);
  } catch {
    throw new LlmOutputError();
  }
  const parsed = generationSchema.safeParse(reply);
  if (!parsed.success) throw new LlmOutputError();
  return parsed.data;
}
