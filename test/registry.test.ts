import { test } from "node:test";
import assert from "node:assert/strict";
import { tools, type ToolCtx } from "../src/tools/registry.ts";
import type { Result } from "../src/core/contract.ts";

const find = (name: string) => tools.find((t) => t.name === name)!;
const fakeCtx = (overrides: Partial<ToolCtx> = {}): ToolCtx => ({
  cfg: { baseUrl: "http://x", openapiToken: "t", consoleToken: "t", workspaceId: "w" },
  openapi: null,
  console: null,
  ...overrides,
});

test("app.import auto-confirms when import is pending", async () => {
  const calls: string[] = [];
  const fake = {
    importDsl: async (_w: string, _b: Record<string, unknown>): Promise<Result<unknown>> => {
      calls.push("import");
      return { ok: true, data: { import_id: "i1", status: "pending" } };
    },
    confirmImport: async (_w: string, id: string): Promise<Result<unknown>> => {
      calls.push(`confirm:${id}`);
      return { ok: true, data: { result: "success", app_id: "new-app" } };
    },
  };
  const r = await find("app.import").run({ workspace_id: "w", yaml: "kind: app", confirm: true }, fakeCtx({ openapi: fake as never }));
  assert.ok(r.ok);
  if (r.ok) assert.equal((r.data as Record<string, unknown>).confirmed, true);
  assert.deepEqual(calls, ["import", "confirm:i1"]);
});

test("app.import skips confirm when import completes immediately", async () => {
  const fake = {
    importDsl: async (): Promise<Result<unknown>> => ({ ok: true, data: { result: "success", app_id: "a1" } }),
    confirmImport: async (): Promise<Result<unknown>> => { throw new Error("should not confirm"); },
  };
  const r = await find("app.import").run({ workspace_id: "w", yaml: "kind: app", confirm: true }, fakeCtx({ openapi: fake as never }));
  assert.ok(r.ok);
  if (r.ok) assert.equal((r.data as Record<string, unknown>).confirmed, false);
});

test("app.import prefers console cookies and does not require workspace_id", async () => {
  const calls: string[] = [];
  const fake = {
    importDsl: async (_body: Record<string, unknown>): Promise<Result<unknown>> => {
      calls.push("import");
      return { ok: true, data: { id: "i1", status: "completed_but_needs_plugin_install" } };
    },
    confirmImport: async (id: string): Promise<Result<unknown>> => {
      calls.push(`confirm:${id}`);
      return { ok: true, data: { status: "completed", app_id: "new-app" } };
    },
  };
  const r = await find("app.import").run(
    { yaml: "kind: app", confirm: true },
    fakeCtx({ openapi: null, console: fake as never }),
  );
  assert.ok(r.ok);
  if (r.ok) assert.equal((r.data as Record<string, unknown>).confirmed, true);
  assert.deepEqual(calls, ["import", "confirm:i1"]);
});

test("workflow.sync_draft dry_run returns a structural diff", async () => {
  const current = {
    graph: {
      nodes: [{ id: "s", data: { type: "start", variables: [] } }, { id: "a", data: { type: "answer", answer: "hi" } }],
      edges: [{ source: "s", target: "a" }],
    },
    features: {},
    hash: "h1",
  };
  const fake = { getDraft: async (): Promise<Result<unknown>> => ({ ok: true, data: current }) };
  const next = {
    nodes: [...current.graph.nodes, { id: "b", data: { type: "answer", answer: "bye" } }],
    edges: [...current.graph.edges, { source: "s", target: "b" }],
  };
  const r = await find("workflow.sync_draft").run({ app_id: "a1", graph: next, dry_run: true }, fakeCtx({ console: fake as never }));
  assert.ok(r.ok);
  if (r.ok) {
    const diff = (r.data as Record<string, unknown>).diff as Record<string, Record<string, unknown>>;
    assert.deepEqual(diff.nodes.added, ["b"]);
    assert.deepEqual(diff.edges.added, ["s->b:"]);
  }
});

test("workflow.sync_draft rejects an invalid graph before touching the server", async () => {
  const fake = { getDraft: async (): Promise<Result<unknown>> => { throw new Error("must not fetch"); } };
  const bad = { nodes: [{ id: "x", data: { type: "llm", model: {}, prompt_template: [] } }], edges: [] };
  const r = await find("workflow.sync_draft").run({ app_id: "a1", graph: bad, dry_run: true }, fakeCtx({ console: fake as never }));
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, "VALIDATION_FAILED");
});
