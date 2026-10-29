import { MongoServerError, type Db, type Document } from "mongodb";
import { AppError } from "../errors.js";
import { generatePipeline, type Llm } from "./generate.js";
import { sampleSchema } from "./schema.js";
import { validatePipeline } from "./validate.js";

export const MAX_TIME_MS = 5000;
const MAX_ATTEMPTS = 2;

export class QueryRejectedError extends AppError {
  constructor(readonly errors: string[]) {
    super(422, "unsafe_query", "The generated query was rejected by the safety validator.", errors);
    this.name = "QueryRejectedError";
  }
}

export interface AnswerInput {
  question: string;
  collection: string;
}

export interface AnswerResult {
  pipeline: Document[];
  explanation: string;
  results: Document[];
  attempts: number;
}

export type Answer = (i: AnswerInput) => Promise<AnswerResult>;

export interface ServiceDeps {
  db: Db;
  llm: Llm;
  allowedCollections: string[];
  maxLimit?: number;
}

type Parsed = { ok: true; value: unknown } | { ok: false; errors: string[] };

function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, errors: [`pipelineJson is not valid JSON: ${(err as Error).message}`] };
  }
}

/** generate -> parse -> validate -> execute, with one repair round that feeds the errors back to the model. */
export function createAnswer(deps: ServiceDeps): Answer {
  return async ({ question, collection }) => {
    const schema = await sampleSchema(deps.db, collection);
    let previousErrors: string[] | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const generation = await generatePipeline(deps.llm, { question, collection, schema, previousErrors });

      const parsed = parseJson(generation.pipelineJson);
      const checked = parsed.ok
        ? validatePipeline(parsed.value, { allowedCollections: deps.allowedCollections, maxLimit: deps.maxLimit })
        : parsed;
      if (!checked.ok) {
        previousErrors = checked.errors;
        continue;
      }

      try {
        const results = await deps.db
          .collection(collection)
          .aggregate(checked.pipeline, { maxTimeMS: MAX_TIME_MS })
          .toArray();
        return { pipeline: checked.pipeline, explanation: generation.explanation, results, attempts: attempt };
      } catch (err) {
        if (!(err instanceof MongoServerError)) throw err;
        previousErrors = [`execution failed: ${err.message}`];
      }
    }
    throw new QueryRejectedError(previousErrors ?? []);
  };
}
