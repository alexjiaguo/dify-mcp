import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyHttpFailure } from "../src/core/http.ts";
import { resolveConfig } from "../src/core/config.ts";
import { parseCookieJson } from "../src/core/cookies.ts";
import { runTool, tools, type ToolCtx } from "../src/tools/registry.ts";
import type { Result } from "../src/core/contract.ts";

const find = (name: string) => tools.find((t) => t.name === name)!;
const startGraph = {
  nodes: [{ id: "s", data: { type: "start", variables: [] } }],
  edges: [] as { source: string; target: string }[],
};
const fakeCtx = (overrides: Partial<ToolCtx> = {}): ToolCtx => ({
  cfg: { baseUrl: "http://x", openapiToken: "t", consoleToken: "t", workspaceId: "w" },
  openapi: null,
  console: null,
  ...overrides,
});

async function withHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(path.join(tmpdir(), "difywf-home-"));
  const prev = process.env.DIFYWF_HOME;
  process.env.DIFYWF_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.DIFYWF_HOME;
    else process.env.DIFYWF_HOME = prev;
  }
}

test("stale draft hash is VALIDATION_FAILED and retryable", () => {
  const r = classifyHttpFailure(400, { code: "draft_workflow_not_sync", message: "DraftWorkflowNotSync" }, "");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.code, "VALIDATION_FAILED");
    assert.equal(r.error.retryable, true);
  }
});

test("parseCookieJson accepts {cookies:[]} and name/value objects", () => {
  const wrapped = parseCookieJson(JSON.stringify({
    cookies: [{ name: "console_token", value: "abc" }, { name: "csrf_token", value: "xyz" }],
  }));
  assert.equal(wrapped.console_token, "abc");
  const obj = parseCookieJson(JSON.stringify({ console_token: "t", csrf_token: "c" }));
  assert.equal(obj.console_token, "t");
});

test("resolveConfig reads DIFY_CONSOLE_COOKIE when DIFYWF_HOME is set", async () => {
  await withHome(() => {
    const prevBase = process.env.DIFY_API_BASE;
    const prevCookie = process.env.DIFY_CONSOLE_COOKIE;
    process.env.DIFY_API_BASE = "https://dify.example";
    process.env.DIFY_CONSOLE_COOKIE = "console_token=abc; csrf_token=xyz; refresh_token=r";
    try {
      const cfg = resolveConfig({});
      assert.equal(cfg.baseUrl, "https://dify.example");
      assert.equal(cfg.consoleCookies?.console_token, "abc");
      assert.equal(cfg.consoleCookies?.csrf_token, "xyz");
    } finally {
      if (prevBase === undefined) delete process.env.DIFY_API_BASE;
      else process.env.DIFY_API_BASE = prevBase;
      if (prevCookie === undefined) delete process.env.DIFY_CONSOLE_COOKIE;
      else process.env.DIFY_CONSOLE_COOKIE = prevCookie;
    }
  });
});

test("workflow.sync_draft preserves env vars when omitted", async () => {
  let captured: Record<string, unknown> = {};
  const fake = {
    getDraft: async (): Promise<Result<unknown>> => ({
      ok: true,
      data: {
        graph: startGraph,
        features: { file_upload: true },
        environment_variables: [{ name: "SECRET", value: "x" }],
        conversation_variables: [{ name: "c", value: "y" }],
        hash: "h1",
      },
    }),
    syncDraft: async (_id: string, body: Record<string, unknown>): Promise<Result<unknown>> => {
      captured = body;
      return { ok: true, data: { hash: "h2" } };
    },
  };
  const r = await find("workflow.sync_draft").run(
    { app_id: "a1", graph: startGraph },
    fakeCtx({ console: fake as never }),
  );
  assert.ok(r.ok);
  assert.deepEqual(captured.environment_variables, [{ name: "SECRET", value: "x" }]);
  assert.deepEqual(captured.conversation_variables, [{ name: "c", value: "y" }]);
  assert.deepEqual(captured.features, { file_upload: true });
  assert.equal(captured.hash, "h1");
});

test("workflow.sync_draft accepts graph_json", async () => {
  let captured: Record<string, unknown> = {};
  const fake = {
    getDraft: async (): Promise<Result<unknown>> => ({ ok: true, data: { graph: startGraph, hash: "h1" } }),
    syncDraft: async (_id: string, body: Record<string, unknown>): Promise<Result<unknown>> => {
      captured = body;
      return { ok: true, data: { hash: "h2" } };
    },
  };
  const r = await find("workflow.sync_draft").run(
    { app_id: "a1", graph_json: JSON.stringify(startGraph) },
    fakeCtx({ console: fake as never }),
  );
  assert.ok(r.ok);
  assert.deepEqual(captured.graph, startGraph);
});

test("workflow.sync_draft requires confirm when the graph has code nodes", async () => {
  const graph = {
    nodes: [
      { id: "s", data: { type: "start", variables: [] } },
      { id: "c", data: { type: "code", code_language: "python3", code: "return {}", outputs: {} } },
    ],
    edges: [{ source: "s", target: "c" }],
  };
  const fake = {
    getDraft: async (): Promise<Result<unknown>> => ({ ok: true, data: { graph: startGraph, hash: "h1" } }),
    syncDraft: async (): Promise<Result<unknown>> => { throw new Error("must not sync"); },
  };
  const r = await find("workflow.sync_draft").run(
    { app_id: "a1", graph },
    fakeCtx({ console: fake as never }),
  );
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, "CONFIRM_REQUIRED");
});

test("auth.import_cookies stores cookie-editor JSON", async () => {
  await withHome(async () => {
    const r = await runTool(
      find("auth.import_cookies"),
      {
        base_url: "https://dify.example",
        cookies: [
          { name: "console_token", value: "abc" },
          { name: "csrf_token", value: "xyz" },
          { name: "refresh_token", value: "r" },
        ],
      },
      { _surface: "mcp" },
    );
    assert.ok(r.ok);
  });
});

test("runTool gates trigger.enable without confirm", async () => {
  const r = await runTool(find("trigger.enable"), { app_id: "a1", enabled: true }, { _surface: "mcp" });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, "CONFIRM_REQUIRED");
});

test("app.export include_secret requires confirm", async () => {
  const fake = { exportDsl: async (): Promise<Result<string>> => { throw new Error("must not export"); } };
  const r = await find("app.export").run(
    { app_id: "a1", include_secret: true },
    fakeCtx({ console: fake as never }),
  );
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, "CONFIRM_REQUIRED");
});

test("file.upload uses console without app_id", async () => {
  let captured: Record<string, unknown> | undefined;
  const fake = {
    uploadFile: async (file: Record<string, unknown>): Promise<Result<unknown>> => {
      captured = file;
      return { ok: true, data: { id: "f1" } };
    },
  };
  const r = await find("file.upload").run(
    { file: { name: "a.txt", content_b64: "YQ==" } },
    fakeCtx({ console: fake as never, openapi: null }),
  );
  assert.ok(r.ok);
  assert.equal(captured?.name, "a.txt");
});

test("workflow.run prefers console over OpenAPI", async () => {
  const calls: string[] = [];
  const console = {
    runPublished: async (): Promise<Result<unknown[]>> => {
      calls.push("console");
      return { ok: true, data: [] };
    },
  };
  const openapi = {
    runApp: async (): Promise<Result<unknown[]>> => {
      calls.push("openapi");
      return { ok: true, data: [] };
    },
  };
  const r = await find("workflow.run").run(
    { app_id: "a1", inputs: { q: "hi" } },
    fakeCtx({ console: console as never, openapi: openapi as never }),
  );
  assert.ok(r.ok);
  assert.deepEqual(calls, ["console"]);
});

test("workspace.switch persists workspace_id", async () => {
  await withHome(async (home) => {
    const fake = {
      switchWorkspace: async (id: string): Promise<Result<unknown>> => ({ ok: true, data: { tenant_id: id } }),
    };
    const r = await find("workspace.switch").run(
      { workspace_id: "ws-2" },
      fakeCtx({ console: fake as never, cfg: { baseUrl: "https://dify.example", workspaceId: "old" } }),
    );
    assert.ok(r.ok);
    const stored = JSON.parse(readFileSync(path.join(home, "hosts.json"), "utf8")) as {
      hosts: Record<string, { workspace_id?: string }>;
    };
    assert.equal(stored.hosts["https://dify.example"]?.workspace_id, "ws-2");
  });
});

test("plugin.install is confirm-gated", async () => {
  const r = await runTool(find("plugin.install"), { identifiers: ["p1"] }, { _surface: "mcp" });
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.error.code, "CONFIRM_REQUIRED");
});

test("output-file acknowledgement reports failure", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "difywf-output-"));
  const output = path.join(dir, "result.json");
  let stdout = "";
  try {
    stdout = execFileSync(
      process.execPath,
      ["bin/difywf.js", "app", "delete", "missing", "--output-file", output],
      { encoding: "utf8" },
    );
  } catch (e) {
    stdout = (e as { stdout?: string }).stdout ?? "";
  }
  const acknowledgement = JSON.parse(stdout);
  const result = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(acknowledgement.ok, false);
  assert.equal(acknowledgement.output_file, output);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CONFIRM_REQUIRED");
});

test("difywf mcp rejects unknown subcommands", () => {
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, ["bin/difywf.js", "mcp", "hack"], { encoding: "utf8" });
  } catch (e) {
    stdout = (e as { stdout?: string }).stdout ?? "";
  }
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "USAGE_ERROR");
});
