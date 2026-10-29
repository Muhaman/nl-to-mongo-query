import { describe, expect, it } from "vitest";
import { validatePipeline } from "../src/query/validate.js";

const opts = { allowedCollections: ["movies"] };

function errorsOf(pipeline: unknown, o = opts): string[] {
  const result = validatePipeline(pipeline, o);
  if (result.ok) throw new Error("expected the pipeline to be rejected");
  return result.errors;
}

describe("validatePipeline", () => {
  it("rejects $where nested inside $match", () => {
    const errors = errorsOf([{ $match: { $or: [{ year: 1999 }, { $where: "sleep(1000)" }] } }]);
    expect(errors.join("\n")).toContain("$where");
  });

  it("rejects $function nested inside $expr", () => {
    const errors = errorsOf([
      { $match: { $expr: { $function: { body: "function() { return true; }", args: [], lang: "js" } } } },
    ]);
    expect(errors.join("\n")).toContain("$function");
  });

  it("rejects $out", () => {
    expect(errorsOf([{ $out: "stolen" }]).join("\n")).toContain("$out");
  });

  it("rejects $merge", () => {
    expect(errorsOf([{ $merge: { into: "movies" } }]).join("\n")).toContain("$merge");
  });

  it("rejects $lookup from a collection that is not allowed", () => {
    const errors = errorsOf([
      { $lookup: { from: "users", localField: "director", foreignField: "name", as: "u" } },
    ]);
    expect(errors.join("\n")).toContain("users");
  });

  it("accepts $lookup from an allowed collection", () => {
    const result = validatePipeline(
      [{ $lookup: { from: "movies", localField: "director", foreignField: "director", as: "same" } }],
      opts,
    );
    expect(result.ok).toBe(true);
  });

  it("denies operators inside a $lookup sub-pipeline", () => {
    const errors = errorsOf([
      { $lookup: { from: "movies", pipeline: [{ $match: { $where: "true" } }], as: "x" } },
    ]);
    expect(errors.join("\n")).toContain("$where");
  });

  it("rejects stages that are not allowlisted inside a $lookup sub-pipeline", () => {
    const errors = errorsOf([
      { $lookup: { from: "movies", pipeline: [{ $out: "x" }], as: "x" } },
    ]);
    expect(errors.join("\n")).toContain("$out");
  });

  it.each(["$facet", "$unionWith", "$graphLookup"])("rejects %s as a stage that is not allowlisted", (stage) => {
    expect(errorsOf([{ [stage]: {} }]).join("\n")).toContain(stage);
  });

  it("rejects a stage object with several keys", () => {
    expect(errorsOf([{ $match: {}, $sort: { year: 1 } }])).not.toHaveLength(0);
  });

  it("rejects input that is not an array of objects", () => {
    expect(errorsOf({ $match: {} })).not.toHaveLength(0);
    expect(errorsOf(["$match"])).not.toHaveLength(0);
  });

  it("appends a $limit of 100 when none is present", () => {
    const result = validatePipeline([{ $match: { year: 2001 } }], opts);
    expect(result).toEqual({ ok: true, pipeline: [{ $match: { year: 2001 } }, { $limit: 100 }] });
  });

  it("clamps an oversized $limit to 100", () => {
    const result = validatePipeline([{ $limit: 1000 }], opts);
    expect(result).toEqual({ ok: true, pipeline: [{ $limit: 100 }] });
  });

  it("keeps a smaller $limit and honours a custom maxLimit", () => {
    expect(validatePipeline([{ $limit: 5 }], opts)).toEqual({ ok: true, pipeline: [{ $limit: 5 }] });
    expect(validatePipeline([{ $match: {} }], { ...opts, maxLimit: 10 })).toEqual({
      ok: true,
      pipeline: [{ $match: {} }, { $limit: 10 }],
    });
  });

  it("caps the result size when a $limit is followed by further stages", () => {
    const result = validatePipeline([{ $limit: 5 }, { $unwind: "$genres" }], opts);
    expect(result).toEqual({ ok: true, pipeline: [{ $limit: 5 }, { $unwind: "$genres" }, { $limit: 100 }] });
  });

  it("rejects a non-positive-integer $limit", () => {
    expect(errorsOf([{ $limit: -1 }])).not.toHaveLength(0);
    expect(errorsOf([{ $limit: "10" }])).not.toHaveLength(0);
  });

  it("does not mutate its input", () => {
    const input = [{ $limit: 1000 }];
    validatePipeline(input, opts);
    expect(input).toEqual([{ $limit: 1000 }]);
  });

  it("collects every error rather than stopping at the first", () => {
    expect(errorsOf([{ $out: "a" }, { $facet: {} }]).length).toBeGreaterThanOrEqual(2);
  });
});
