import type Anthropic from "@anthropic-ai/sdk";
import { LlmRefusalError, LlmTruncatedError, type Llm, type LlmRequest } from "./generate.js";

const MAX_TOKENS = 16_000;

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
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      output_config: { effort: "medium", format: OUTPUT_FORMAT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });

    if (response.stop_reason === "refusal") throw new LlmRefusalError(response.stop_details?.category ?? null);
    if (response.stop_reason === "max_tokens") throw new LlmTruncatedError();
    return response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  }
}
