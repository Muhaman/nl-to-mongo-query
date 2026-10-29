import Anthropic from "@anthropic-ai/sdk";
import { LlmRefusalError, LlmTruncatedError, LlmUpstreamError, type Llm, type LlmRequest } from "./generate.js";

const MAX_TOKENS = 16_000;

// Server-side refusal fallback is only accepted by these models; others (e.g. Haiku) reject the parameter.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

// Strict structured output: the pipeline travels as a JSON string because
// aggregation stages are open-ended and cannot be expressed as a closed schema.
const OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      pipelineJson: { type: "string", description: "A JSON array of aggregation pipeline stages." },
      explanation: { type: "string", description: "One or two sentences describing what the pipeline does." },
    },
    required: ["pipelineJson", "explanation"],
    additionalProperties: false,
  },
};

export class ClaudeLlm implements Llm {
  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async complete({ system, prompt }: LlmRequest): Promise<string> {
    let response;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system,
        output_config: { effort: "medium", format: OUTPUT_FORMAT },
        ...(FALLBACK_MODELS.has(this.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        messages: [{ role: "user", content: prompt }],
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new LlmUpstreamError();
      throw err;
    }

    if (response.stop_reason === "refusal") throw new LlmRefusalError(response.stop_details?.category ?? null);
    if (response.stop_reason === "max_tokens") throw new LlmTruncatedError();
    return response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  }
}
