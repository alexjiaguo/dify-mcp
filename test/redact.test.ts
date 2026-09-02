import { test } from "node:test";
import assert from "node:assert/strict";
import { redactArgs } from "../src/core/redact.ts";

test("redactArgs hides nested credentials and cookies", () => {
  const out = redactArgs({
    graph: { nodes: [{ id: "s" }] },
    credentials: { api_key: "sk-live" },
    nested: { password: "pw", ok: 1 },
    yaml: "kind: app",
  });
  assert.equal(out.credentials, "[redacted]");
  assert.equal(out.graph, "[redacted]");
  assert.equal(out.yaml, "[redacted]");
  assert.deepEqual(out.nested, { password: "[redacted]", ok: 1 });
});
