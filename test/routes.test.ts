import { pino } from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { LlmRefusalError, LlmTruncatedError } from "../src/query/generate.js";
import { QueryRejectedError } from "../src/query/service.js";

const okResult = {
  pipeline: [{ $match: { year: 2001 } }, { $limit: 100 }],
  explanation: "Movies from 2001.",
  results: [{ title: "Synthetic Dawn" }],
  attempts: 1,
};

function app(answer: AppDeps["answer"] = vi.fn().mockResolvedValue(okResult), extra: Partial<AppDeps> = {}) {
  return createApp({
    ...extra,
    answer,
    allowedCollections: ["movies"],
    corsOrigins: ["http://localhost:5173"],
    logger: pino({ level: "silent" }),
  });
}

const body = { question: "Which movies came out in 2001?", collection: "movies" };

describe("POST /v1/query", () => {
  it("returns the pipeline, explanation, results and attempts", async () => {
    const answer = vi.fn().mockResolvedValue(okResult);
    const res = await request(app(answer)).post("/v1/query").send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(okResult);
    expect(answer).toHaveBeenCalledWith(body);
  });

  it("returns 422 unsafe_query with details when the query is rejected", async () => {
    const answer = vi.fn().mockRejectedValue(new QueryRejectedError(["$out is not allowed"]));
    const res = await request(app(answer)).post("/v1/query").send(body);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: { code: "unsafe_query", message: expect.any(String), details: ["$out is not allowed"] },
    });
  });

  it("returns 400 for a question shorter than 3 characters", async () => {
    const answer = vi.fn();
    const res = await request(app(answer)).post("/v1/query").send({ ...body, question: "hi" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    expect(answer).not.toHaveBeenCalled();
  });

  it("returns 400 for a question longer than 500 characters", async () => {
    const res = await request(app()).post("/v1/query").send({ ...body, question: "x".repeat(501) });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the collection is not allowlisted", async () => {
    const answer = vi.fn();
    const res = await request(app(answer)).post("/v1/query").send({ ...body, collection: "users" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("collection_not_allowed");
    expect(answer).not.toHaveBeenCalled();
  });

  it("returns 502 refusal when the model declines", async () => {
    const answer = vi.fn().mockRejectedValue(new LlmRefusalError("cyber"));
    const res = await request(app(answer)).post("/v1/query").send(body);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("refusal");
  });

  it("returns 502 max_tokens when the model output is cut off", async () => {
    const answer = vi.fn().mockRejectedValue(new LlmTruncatedError());
    const res = await request(app(answer)).post("/v1/query").send(body);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("max_tokens");
  });

  it("returns 500 with a generic body for unexpected errors", async () => {
    const answer = vi.fn().mockRejectedValue(new Error("connection string leaked"));
    const res = await request(app(answer)).post("/v1/query").send(body);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal", message: "Internal server error." } });
  });
});

describe("rate limiting", () => {
  it("answers 429 with the JSON error contract once the limit is exceeded", async () => {
    const server = app(undefined, { rateLimitPerMinute: 1 });
    expect((await request(server).post("/v1/query").send(body)).status).toBe(200);
    const res = await request(server).post("/v1/query").send(body);
    expect(res.status).toBe(429);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: { code: "rate_limited", message: "Too many requests." } });
  });

  it("keeps /healthz outside the limiter", async () => {
    const server = app(undefined, { rateLimitPerMinute: 1 });
    await request(server).post("/v1/query").send(body);
    expect((await request(server).get("/healthz")).status).toBe(200);
    expect((await request(server).get("/healthz")).status).toBe(200);
  });
});

describe("service routes", () => {
  it("serves /healthz and echoes x-request-id", async () => {
    const res = await request(app()).get("/healthz").set("x-request-id", "abc-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["x-request-id"]).toBe("abc-123");
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});
