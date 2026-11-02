import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConsoleClient } from "../src/api/console.ts";
import { tools, type ToolCtx } from "../src/tools/registry.ts";
import { validateGraph } from "../src/graph/validate.ts";
import type { Result } from "../src/core/contract.ts";

const find = (name: string) => tools.find((tool) => tool.name === name)!;
const ctx = (consoleClient: unknown, openapi: unknown = null): ToolCtx => ({
  cfg: { baseUrl: "https://dify.example", openapiToken: "t", consoleToken: "t", workspaceId: "w" },
  console: consoleClient as ToolCtx["console"],
  openapi: openapi as ToolCtx["openapi"],
});
const packageFile = { name: "agent.ifpkg", content_b64: Buffer.from([0x50, 0x4b, 0xff]).toString("base64") };

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("Dify 1.18 YAML export explicitly requests YAML and accepts workflow_id", async () => {
  let requested = "";
  const restore = mockFetch(async (url) => {
    requested = url;
    return Response.json({ data: "version: 0.7.0\nkind: app\n" });
  });
  try {
    const result = await new ConsoleClient("https://dify.example", "token").exportDsl("app-1", false, "wf-1");
    assert.ok(result.ok);
    const url = new URL(requested);
    assert.equal(url.searchParams.get("format"), "yaml");
    assert.equal(url.searchParams.get("workflow_id"), "wf-1");
  } finally { restore(); }
});

test("Dify 1.18 package export preserves bytes and server filename", async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0xff]);
  let requested = "";
  const restore = mockFetch(async (url) => {
    requested = url;
    return new Response(bytes, { headers: {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="Support Agent.ifpkg"',
    } });
  });
  try {
    const result = await new ConsoleClient("https://dify.example", "token").exportPackage("app-1");
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.data.name, "Support Agent.ifpkg");
      assert.equal(result.data.mime, "application/zip");
      assert.deepEqual(Buffer.from(result.data.content_b64, "base64"), Buffer.from(bytes));
    }
    assert.equal(new URL(requested).searchParams.get("format"), "ifpkg");
  } finally { restore(); }
});

test("package import sends multipart fields and preserves pending confirmation", async () => {
  const calls: Array<{ url: string; form?: FormData }> = [];
  const restore = mockFetch(async (url, init) => {
    calls.push({ url, form: init?.body instanceof FormData ? init.body : undefined });
    return calls.length === 1
      ? Response.json({ id: "import-1", status: "pending" })
      : Response.json({ id: "import-1", status: "completed", app_id: "new-app" });
  });
  try {
    const result = await find("app.import").run({
      file: packageFile, app_id: "old-app", draft_hash: "draft-1", name: "Renamed", confirm: true,
    }, ctx(new ConsoleClient("https://dify.example", "token")));
    assert.ok(result.ok);
    if (result.ok) assert.equal((result.data as Record<string, unknown>).confirmed, true);
    const form = calls[0].form!;
    assert.equal(form.get("app_id"), "old-app");
    assert.equal(form.get("draft_hash"), "draft-1");
    assert.equal(form.get("name"), "Renamed");
    const uploaded = form.get("file") as File;
    assert.equal(uploaded.name, "agent.ifpkg");
    assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), new Uint8Array([0x50, 0x4b, 0xff]));
    assert.match(calls[1].url, /apps\/imports\/import-1\/confirm$/);
  } finally { restore(); }
});

test("package import validates input and never falls back to OpenAPI", async () => {
  await assert.rejects(find("app.import").run({
    yaml: "version: 0.7.0\n", file: packageFile, confirm: true,
  }, ctx({})), /exactly one/);
  await assert.rejects(find("app.import").run({
    file: { ...packageFile, name: "agent.zip" }, confirm: true,
  }, ctx({})), /must end in \.ifpkg/);
  await assert.rejects(find("app.import").run({
    file: packageFile, confirm: true,
  }, ctx(null, {})), /console authentication/);
});

test("YAML overwrite includes app_id and draft_hash but OpenAPI does not", async () => {
  let consoleBody: Record<string, unknown> | undefined;
  let openBody: Record<string, unknown> | undefined;
  const completed = async (): Promise<Result<unknown>> => ({ ok: true, data: { status: "completed" } });
  await find("app.import").run({
    yaml: "version: 0.7.0\n", app_id: "app-1", draft_hash: "hash-1", confirm: true,
  }, ctx({ importDsl: async (body: Record<string, unknown>) => { consoleBody = body; return completed(); } }));
  assert.equal(consoleBody?.app_id, "app-1");
  assert.equal(consoleBody?.draft_hash, "hash-1");
  await find("app.import").run({
    yaml: "version: 0.7.0\n", app_id: "app-1", draft_hash: "hash-1", workspace_id: "w", confirm: true,
  }, ctx(null, { importDsl: async (_w: string, body: Record<string, unknown>) => { openBody = body; return completed(); } }));
  assert.equal(openBody?.app_id, undefined);
  assert.equal(openBody?.draft_hash, undefined);
});

test("backup and restore support mixed YAML and ifpkg files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "difywf-1180-backup-"));
  const client = {
    listApps: async (): Promise<Result<unknown>> => ({ ok: true, data: { data: [{ id: "app-1", name: "Portable", mode: "workflow" }], has_more: false } }),
    exportPackage: async (): Promise<Result<unknown>> => ({ ok: true, data: packageFile }),
    importPackage: async (_file: unknown, fields: Record<string, string | undefined>): Promise<Result<unknown>> => {
      assert.equal(fields.name, "Portable");
      return { ok: true, data: { status: "completed", app_id: "imported-app" } };
    },
  };
  const backedUp = await find("app.backup").run({ path: dir, format: "ifpkg" }, ctx(client));
  assert.ok(backedUp.ok);
  assert.deepEqual(fs.readFileSync(path.join(dir, "Portable-app-1.ifpkg")), Buffer.from([0x50, 0x4b, 0xff]));
  const dry = await find("app.restore").run({ path: dir, dry_run: true, on_conflict: "create" }, ctx(client));
  assert.ok(dry.ok);
  if (dry.ok) {
    const imported = (dry.data as Record<string, unknown[]>).imported[0] as Record<string, unknown>;
    assert.equal(imported.name, "Portable");
  }
  const restored = await find("app.restore").run({ path: dir, confirm: true, on_conflict: "create" }, ctx(client));
  assert.ok(restored.ok);
  if (restored.ok) assert.equal((restored.data as Record<string, unknown[]>).failed.length, 0);
});

const routedGraph = (routes: unknown) => ({
  nodes: [
    { id: "start", data: { type: "start", variables: [] } },
    { id: "agent", data: { type: "agent", agent_output_routes: { enabled: true, routes } } },
    { id: "end", data: { type: "end", outputs: [] } },
  ],
  edges: [{ source: "start", target: "agent" }, { source: "agent", target: "end", sourceHandle: "route-1" }],
});

test("Agent Output Routes accept drafts with blank selection conditions", () => {
  const errors = validateGraph(routedGraph([{ id: "route-1", name: "" }, { id: "route-2", name: "" }]))
    .filter((issue) => issue.level === "error");
  assert.deepEqual(errors, []);
});

test("Agent Output Routes reject too few, duplicate, blank, and reserved ids", async () => {
  for (const routes of [
    [{ id: "route-1", name: "Only" }],
    [{ id: "route-1" }, { id: "route-1" }],
    [{ id: "route-1" }, { id: " " }],
    [{ id: "route-1" }, { id: "source" }],
    [{ id: "route-1" }, { id: "target" }],
    [{ id: "route-1" }, { id: "fail-branch" }],
    [{ id: "route-1" }, { id: 2 }],
  ]) {
    const errors = validateGraph(routedGraph(routes)).filter((issue) => issue.code === "INVALID_OUTPUT_ROUTES");
    assert.ok(errors.length > 0, JSON.stringify(routes));
  }
  const errors = validateGraph({
    ...routedGraph([]),
    nodes: [{ id: "agent", data: { type: "agent", agent_output_routes: { enabled: true, routes: "bad" } } }],
  }).filter((issue) => issue.code === "INVALID_OUTPUT_ROUTES");
  assert.ok(errors.length > 0);
});

test("runs.node_children uses the Dify 1.18 child execution endpoint", async () => {
  let requested = "";
  const restore = mockFetch(async (url) => { requested = url; return Response.json({ data: [] }); });
  try {
    const result = await find("runs.node_children").run({
      app_id: "app-1", run_id: "run-1", node_execution_id: "node-run-1",
    }, ctx(new ConsoleClient("https://dify.example", "token")));
    assert.ok(result.ok);
    assert.match(requested, /apps\/app-1\/workflow-runs\/run-1\/node-executions\/node-run-1\/children$/);
  } finally { restore(); }
});
