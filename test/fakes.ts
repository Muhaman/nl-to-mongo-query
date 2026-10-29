import type { Llm, LlmRequest } from "../src/query/generate.js";

export interface GenerationReply {
  pipelineJson: string;
  explanation?: string;
}

/** Replays canned structured replies in order and records every request it receives. */
export class FakeLlm implements Llm {
  readonly requests: LlmRequest[] = [];
  private next = 0;

  constructor(private readonly replies: (GenerationReply | string)[]) {}

  async complete(request: LlmRequest): Promise<string> {
    this.requests.push(request);
    const reply = this.replies[Math.min(this.next++, this.replies.length - 1)];
    if (reply === undefined) throw new Error("FakeLlm has no replies");
    return typeof reply === "string"
      ? reply
      : JSON.stringify({ pipelineJson: reply.pipelineJson, explanation: reply.explanation ?? "test pipeline" });
  }
}
