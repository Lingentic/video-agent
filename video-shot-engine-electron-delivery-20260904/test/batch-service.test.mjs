import test from "node:test";
import assert from "node:assert/strict";
import { sumUsage } from "../src/batch-service.mjs";

test("sums completed batch usage without inventing missing tokens", () => {
  const usage = sumUsage([
    { usage: { total_tokens: 100, total_input_tokens: 70, total_output_tokens: 30, total_thought_tokens: 0 } },
    { status: "failed" },
    { usage: { total_tokens: 50, total_input_tokens: 40, total_output_tokens: 10, total_thought_tokens: 0 } },
  ]);
  assert.deepEqual(usage, { total_tokens: 150, total_input_tokens: 110, total_output_tokens: 40, total_thought_tokens: 0, estimated_cost_yuan: 0.000465 });
});
