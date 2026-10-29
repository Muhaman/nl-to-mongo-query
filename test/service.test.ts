import { MongoClient, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePipeline } from "../src/query/validate.js";
import { createAnswer, QueryRejectedError } from "../src/query/service.js";
import { FakeLlm } from "./fakes.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  db = client.db("test");
  await db.collection("movies").insertMany([
    { title: "Synthetic Dawn", year: 1999, genres: ["Drama"], rating: 7.1 },
    { title: "Synthetic Dusk", year: 2005, genres: ["Drama", "Thriller"], rating: 8.2 },
    { title: "Synthetic Noon", year: 2012, genres: ["Comedy"], rating: 6.4 },
  ]);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

const invalidPipeline = JSON.stringify([{ $match: { $where: "true" } }]);
const validPipeline = JSON.stringify([{ $match: { year: { $gte: 2000 } } }, { $count: "n" }]);
const question = "How many movies came out in 2000 or later?";

function service(llm: FakeLlm) {
  return createAnswer({ db, llm, allowedCollections: ["movies"] });
}

describe("answer", () => {
  it("returns results on the first attempt when the pipeline is valid", async () => {
    const llm = new FakeLlm([{ pipelineJson: validPipeline, explanation: "Counts recent movies." }]);
    const out = await service(llm)({ question, collection: "movies" });
    expect(out.attempts).toBe(1);
    expect(out.explanation).toBe("Counts recent movies.");
    expect(out.results).toEqual([{ n: 2 }]);
    expect(out.pipeline.at(-1)).toEqual({ $limit: 100 });
  });

  it("repairs once: invalid then valid gives attempts 2 and feeds the errors back", async () => {
    const llm = new FakeLlm([{ pipelineJson: invalidPipeline }, { pipelineJson: validPipeline }]);
    const out = await service(llm)({ question, collection: "movies" });

    expect(out.attempts).toBe(2);
    expect(out.results).toEqual([{ n: 2 }]);
    expect(llm.requests).toHaveLength(2);

    const firstErrors = validatePipeline(JSON.parse(invalidPipeline), { allowedCollections: ["movies"] });
    if (firstErrors.ok) throw new Error("fixture should be invalid");
    for (const error of firstErrors.errors) {
      expect(llm.requests[1]?.prompt).toContain(error);
    }
    expect(llm.requests[0]?.prompt).not.toContain(firstErrors.errors[0]);
  });

  it("throws QueryRejectedError when both attempts are invalid", async () => {
    const llm = new FakeLlm([{ pipelineJson: invalidPipeline }]);
    const failure = await service(llm)({ question, collection: "movies" }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(QueryRejectedError);
    expect((failure as QueryRejectedError).errors.join("\n")).toContain("$where");
    expect(llm.requests).toHaveLength(2);
  });

  it("counts unparseable JSON as invalid", async () => {
    const llm = new FakeLlm([{ pipelineJson: "not json {" }, { pipelineJson: validPipeline }]);
    const out = await service(llm)({ question, collection: "movies" });
    expect(out.attempts).toBe(2);
    expect(llm.requests[1]?.prompt).toMatch(/not valid JSON/i);
  });

  it("rejects when the JSON never parses", async () => {
    const llm = new FakeLlm([{ pipelineJson: "[[" }]);
    await expect(service(llm)({ question, collection: "movies" })).rejects.toBeInstanceOf(QueryRejectedError);
  });

  it("treats a pipeline MongoDB refuses to run as repairable", async () => {
    const failing = JSON.stringify([{ $group: { _id: "$genres", n: { $nope: 1 } } }]);
    const llm = new FakeLlm([{ pipelineJson: failing }, { pipelineJson: validPipeline }]);
    const out = await service(llm)({ question, collection: "movies" });
    expect(out.attempts).toBe(2);
    expect(llm.requests[1]?.prompt).toMatch(/execution failed/i);
  });

  it("shows the sampled schema to the model", async () => {
    const llm = new FakeLlm([{ pipelineJson: validPipeline }]);
    await service(llm)({ question, collection: "movies" });
    const prompt = llm.requests[0]?.prompt ?? "";
    expect(prompt).toContain("genres[]");
    expect(prompt).toContain(question);
  });
});
