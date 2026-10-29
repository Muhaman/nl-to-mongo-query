import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleSchema } from "../src/query/schema.js";

let mongod: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  await client.db("test").collection("movies").insertMany(
    Array.from({ length: 10 }, (_, i) => ({
      title: `Synthetic ${i}`,
      year: 2000 + i,
      genres: ["Drama", "Comedy"],
      crew: { director: `Director ${i % 3}` },
      boxOffice: i === 0 ? null : i * 1000,
    })),
  );
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe("sampleSchema", () => {
  it("reports field paths, types and at most three examples each", async () => {
    const schema = await sampleSchema(client.db("test"), "movies");
    const byPath = new Map(schema.fields.map((f) => [f.path, f]));

    expect(schema.collection).toBe("movies");
    expect(byPath.get("year")?.types).toEqual(["number"]);
    expect(byPath.get("year")?.examples.length).toBeLessThanOrEqual(3);
    expect(byPath.get("genres")?.types).toEqual(["array"]);
    expect(byPath.get("genres[]")?.types).toEqual(["string"]);
    expect(byPath.get("crew.director")?.types).toEqual(["string"]);
    expect(byPath.get("_id")?.types).toEqual(["objectId"]);
    expect(byPath.get("boxOffice")?.types).toEqual(expect.arrayContaining(["null", "number"]));
  });

  it("respects the sample size", async () => {
    const schema = await sampleSchema(client.db("test"), "movies", 1);
    expect(schema.fields.find((f) => f.path === "year")?.examples).toHaveLength(1);
  });

  it("returns no fields for an empty collection", async () => {
    const schema = await sampleSchema(client.db("test"), "nothing_here");
    expect(schema.fields).toEqual([]);
  });
});
