import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeLlm } from "../src/query/claude.js";
import {
  generatePipeline,
  LlmOutputError,
  LlmRefusalError,
  LlmTruncatedError,
  LlmUpstreamError,
} from "../src/query/generate.js";
import { FakeLlm } from "./fakes.js";

const schema = {
  collection: "movies",
  fields: [{ path: "year", types: ["number"], examples: [1999, 2005] }],
};
const input = { question: "How many movies are there?", collection: "movies", schema };

describe("generatePipeline", () => {
  it("returns the parsed pipelineJson and explanation", async () => {
    const llm = new FakeLlm([{ pipelineJson: '[{"$count":"n"}]', explanation: "Counts." }]);
    await expect(generatePipeline(llm, input)).resolves.toEqual({
      pipelineJson: '[{"$count":"n"}]',
      explanation: "Counts.",
    });
  });

  it("puts the question, schema and previous errors in the prompt", async () => {
    const llm = new FakeLlm([{ pipelineJson: "[]" }]);
    await generatePipeline(llm, { ...input, previousErrors: ["stage 1 is bad"] });
    const prompt = llm.requests[0]?.prompt ?? "";
    expect(prompt).toContain(input.question);
    expect(prompt).toContain("- year: number e.g. 1999, 2005");
    expect(prompt).toContain("- stage 1 is bad");
  });

  it("throws invalid_model_output for a truncated JSON reply", async () => {
    const llm = new FakeLlm(['{"pipelineJson": "[{']);
    const err = await generatePipeline(llm, input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmOutputError);
    expect((err as LlmOutputError).status).toBe(502);
    expect((err as LlmOutputError).code).toBe("invalid_model_output");
  });

  it("throws invalid_model_output when the reply does not match the schema", async () => {
    const llm = new FakeLlm([JSON.stringify({ pipelineJson: 42 })]);
    await expect(generatePipeline(llm, input)).rejects.toBeInstanceOf(LlmOutputError);
  });
});

function stubClient(create: () => Promise<unknown>): Anthropic {
  return { beta: { messages: { create } } } as unknown as Anthropic;
}

describe("ClaudeLlm", () => {
  const request = { system: "s", prompt: "p" };

  it("joins the text blocks of an end_turn reply and sends the structured-output request", async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "thinking" }, { type: "text", text: '{"a":' }, { type: "text", text: "1}" }],
    });
    const text = await new ClaudeLlm(stubClient(create), "claude-opus-5-5").complete(request);
    expect(text).toBe('{"a":1}');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-5-5",
        system: "s",
        output_config: expect.objectContaining({ effort: "medium" }),
        fallbacks: "default",
      }),
    );
  });

  it("sends no betas or fallbacks to models without server-side fallback", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] });
    await new ClaudeLlm(stubClient(create), "claude-haiku-5-5").complete(request);
    const params = create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty("betas");
    expect(params).not.toHaveProperty("fallbacks");
  });

  it.each(["claude-opus-5-5", "claude-sonnet-5-5"])("enables the fallback beta for %s", async (model) => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] });
    await new ClaudeLlm(stubClient(create), model).complete(request);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
    );
  });

  it("maps stop_reason refusal to LlmRefusalError", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] });
    await expect(new ClaudeLlm(stubClient(create), "m").complete(request)).rejects.toBeInstanceOf(LlmRefusalError);
  });

  it("maps stop_reason max_tokens to LlmTruncatedError", async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: "max_tokens", content: [] });
    await expect(new ClaudeLlm(stubClient(create), "m").complete(request)).rejects.toBeInstanceOf(LlmTruncatedError);
  });

  it("maps Anthropic API errors to a 502 upstream_error", async () => {
    const create = vi.fn().mockRejectedValue(Object.create(Anthropic.APIError.prototype));
    const err = await new ClaudeLlm(stubClient(create), "m").complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUpstreamError);
    expect((err as LlmUpstreamError).status).toBe(502);
    expect((err as LlmUpstreamError).code).toBe("upstream_error");
  });

  it("does not swallow unrelated errors", async () => {
    const create = vi.fn().mockRejectedValue(new TypeError("bug"));
    await expect(new ClaudeLlm(stubClient(create), "m").complete(request)).rejects.toBeInstanceOf(TypeError);
  });
});
