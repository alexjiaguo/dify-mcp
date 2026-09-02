import { test } from "node:test";
import assert from "node:assert/strict";
import { tools, runTool, type ToolCtx } from "../src/tools/registry.ts";
import type { Result } from "../src/core/contract.ts";

const find = (name: string) => tools.find((t) => t.name === name)!;
const fakeCtx = (overrides: Partial<ToolCtx> = {}): ToolCtx => ({
  cfg: { baseUrl: "http://x", openapiToken: "t", consoleToken: "t", workspaceId: "w" },
  openapi: null,
  console: null,
  ...overrides,
});

test("registry has 144 tools, all names unique", () => {
  const names = tools.map((t) => t.name);
  assert.equal(names.length, 144);
  assert.equal(new Set(names).size, 144);
});

test("every tool name is ns.verb and maps to an MCP-safe name", () => {
  const mcpRe = /^[a-zA-Z0-9_-]{1,64}$/;
  const seen = new Set<string>();
  for (const t of tools) {
    assert.match(t.name, /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/, `bad dotted name: ${t.name}`);
    const mcp = t.name.replaceAll(".", "_");
    assert.match(mcp, mcpRe, `bad mcp name: ${mcp}`);
    assert.ok(!seen.has(mcp), `mcp name collision: ${mcp}`);
    seen.add(mcp);
  }
});

test("every confirm-gated tool declares confirm in its required schema", () => {
  for (const t of tools) {
    if (!t.confirm) continue;
    const required = (t.schema as { required?: string[] }).required ?? [];
    assert.ok(required.includes("confirm"), `${t.name} is confirm-gated but omits confirm from required`);
  }
});

test("every tool has a non-empty summary and a run fn", () => {
  for (const t of tools) {
    assert.ok(t.summary && t.summary.length > 0, `${t.name} missing summary`);
    assert.equal(typeof t.run, "function", `${t.name} missing run`);
  }
});

test("the four deferred groups are all present", () => {
  const groups = ["annotation", "rag", "snippet", "agent"];
  for (const g of groups) {
    const count = tools.filter((t) => t.name.startsWith(g + ".")).length;
    assert.ok(count >= 8, `${g}.* has only ${count} tools`);
  }
  // spot-check representative new tools exist
  for (const n of [
    "annotation.batch_import", "annotation.hit_histories",
    "rag.create_dataset", "rag.sync_draft", "rag.publish", "rag.delete_version",
    "snippet.create", "snippet.sync_draft", "snippet.run_draft", "snippet.delete",
    "agent.config_manifest", "agent.drive_download", "agent.sandbox_upload",
  ]) {
    assert.ok(find(n), `missing ${n}`);
  }
});

test("snippet.import auto-confirms when import is pending (2-step)", async () => {
  const calls: string[] = [];
  const fake = {
    importSnippet: async (_b: Record<string, unknown>): Promise<Result<unknown>> => {
      calls.push("import");
      return { ok: true, data: { import_id: "imp1", status: "pending" } };
    },
    confirmSnippetImport: async (id: string): Promise<Result<unknown>> => {
      calls.push(`confirm:${id}`);
      return { ok: true, data: { result: "success", snippet_id: "s-new" } };
    },
  };
  const r = await find("snippet.import").run({ yaml: "kind: snippet", confirm: true }, fakeCtx({ console: fake as never }));
  assert.ok(r.ok);
  if (r.ok) assert.equal((r.data as Record<string, unknown>).confirmed, true);
  assert.deepEqual(calls, ["import", "confirm:imp1"]);
});

test("snippet.import skips confirm when import completes immediately", async () => {
  const fake = {
    importSnippet: async (): Promise<Result<unknown>> => ({ ok: true, data: { result: "success", snippet_id: "s1" } }),
    confirmSnippetImport: async (): Promise<Result<unknown>> => { throw new Error("must not confirm"); },
  };
  const r = await find("snippet.import").run({ yaml: "kind: snippet", confirm: true }, fakeCtx({ console: fake as never }));
  assert.ok(r.ok);
  if (r.ok) assert.equal((r.data as Record<string, unknown>).confirmed, false);
});

test("snippet.import rejects when neither yaml nor yaml_url is given", async () => {
  // routed through runTool, which converts the thrown ToolError into a Result
  const r = await runTool(find("snippet.import"), { confirm: true }, { _surface: "cli" });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, "USAGE_ERROR");
});

test("rag.sync_draft forwards graph/features/hash to the client", async () => {
  let captured: Record<string, unknown> = {};
  const fake = {
    syncRagDraft: async (_p: string, body: Record<string, unknown>): Promise<Result<unknown>> => {
      captured = body;
      return { ok: true, data: { hash: "h2" } };
    },
  };
  const r = await find("rag.sync_draft").run(
    { pipeline_id: "p1", graph: { nodes: [], edges: [] }, features: { x: 1 }, hash: "h1" },
    fakeCtx({ console: fake as never }),
  );
  assert.ok(r.ok);
  assert.deepEqual(captured, { graph: { nodes: [], edges: [] }, features: { x: 1 }, hash: "h1" });
});

test("agent.sandbox_upload forwards the file payload", async () => {
  let captured: Record<string, unknown> = {};
  const fake = {
    agentSandboxUpload: async (_id: string, body: Record<string, unknown>): Promise<Result<unknown>> => {
      captured = body;
      return { ok: true, data: { ok: true } };
    },
  };
  const r = await find("agent.sandbox_upload").run(
    { agent_id: "a1", file: { name: "f.txt", content_b64: "AA==" }, confirm: true },
    fakeCtx({ console: fake as never }),
  );
  assert.ok(r.ok);
  assert.equal((captured as Record<string, unknown>).name, "f.txt");
});

test("runTool gates a new confirm tool with CONFIRM_REQUIRED", async () => {
  const r = await runTool(find("rag.delete_version"), { pipeline_id: "p1", workflow_id: "w1" }, { _surface: "cli" });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, "CONFIRM_REQUIRED");
});

test("runTool gates annotation.batch_import without confirm", async () => {
  const r = await runTool(find("annotation.batch_import"), { app_id: "a1", file: { name: "x.csv" } }, { _surface: "mcp" });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, "CONFIRM_REQUIRED");
});

test("agent.guide 'more' section lists the new surfaces", async () => {
  const r = await find("agent.guide").run({ section: "more" }, fakeCtx());
  assert.ok(r.ok);
  const text = String((r as { ok: true; data: unknown }).data);
  assert.ok(text.includes("RAG pipelines"), "more section missing RAG pipelines");
  assert.ok(text.includes("Customized snippets"), "more section missing snippets");
  assert.ok(text.includes("Agent config / drive / sandbox"), "more section missing agent");
});
