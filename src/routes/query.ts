import { Router } from "express";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { Answer } from "../query/service.js";

const bodySchema = z.object({
  question: z.string().min(3).max(500),
  collection: z.string().min(1).max(128),
});

export interface QueryRouterDeps {
  answer: Answer;
  allowedCollections: string[];
}

export function queryRouter(deps: QueryRouterDeps): Router {
  const router = Router();
  router.post("/", async (req, res) => {
    const input = bodySchema.parse(req.body);
    if (!deps.allowedCollections.includes(input.collection)) {
      throw new AppError(400, "collection_not_allowed", `Collection "${input.collection}" is not queryable.`);
    }
    res.json(await deps.answer(input));
  });
  return router;
}
