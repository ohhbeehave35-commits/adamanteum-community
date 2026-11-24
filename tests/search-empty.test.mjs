import assert from "node:assert/strict";
import { test } from "node:test";
import { searchPlan } from "../vault-search.mjs";

test("an empty operator is not a search for every note", () => {
  const plan = searchPlan("pool path:");
  assert.deepEqual(plan.filters, []);
  assert.deepEqual(plan.terms.map((t) => t.value), ["pool"]);
  assert.equal(searchPlan("-").groups.length, 0);
  assert.equal(searchPlan('file:""').filters.length, 0);
  assert.equal(searchPlan("path:notes").filters[0].value, "notes");
});
