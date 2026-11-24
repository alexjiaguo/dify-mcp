import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConsoleClient } from "../src/api/console.ts";
import { OpenapiClient } from "../src/api/openapi.ts";
import { maskToken, resolveConfig } from "../src/core/config.ts";
import { redactArgs } from "../src/core/redact.ts";
import { runTool, tools, type ToolCtx } from "../src/tools/registry.ts";
import type { Result } from "../src/core/contract.ts";

const find = (name: string) => tools.find((tool) => tool.name === name)!;
const ctx = (consoleClient: unknown, openapi: unknown = null): ToolCtx => ({
  cfg: { baseUrl: "https://dify.example", openapiToken: "dpat_test", consoleToken: "t", workspaceId: "w" },
  console: consoleClient as ToolCtx["console"],
  openapi: openapi as ToolCtx["openapi"],
});
const success = async (data: unknown = { result: "success" }): Promise<Result<unknown>> => ({ ok: true, data });

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("ConsoleClient PAT routes, methods, query params, and Idempotency-Key header", async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const restore = mockFetch(async (url, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Response.json({ ok: true });
  });
  try {
    const client = new ConsoleClient("https://dify.example", undefined, {
      access_token: "sess",
      csrf_token: "csrf-1",
    });

    assert.ok((await client.listPersonalAccessTokens({ page: 2, limit: 10 })).ok);
    assert.ok((await client.getPersonalAccessToken("pat-1")).ok);
    assert.ok(
      (await client.createPersonalAccessToken(
        { name: "ci-bot", expiration: "90_days" },
        "idem-key-123",
      )).ok,
    );
    assert.ok(
      (await client.updatePersonalAccessToken("pat-1", { name: "ci-bot-v2", version: 1 })).ok,
    );
    assert.ok((await client.revokePersonalAccessToken("pat-1")).ok);
    assert.ok(
      (await client.listPatResourceCandidates({ cursor: 0, limit: 20, keyword: "wf", resource_type: "app" })).ok,
    );
    assert.ok((await client.listPatWorkspaceCandidates({ cursor: 10, limit: 5, keyword: "prod" })).ok);

    assert.equal(calls.length, 7);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].url, "https://dify.example/console/api/account/personal-access-tokens?page=2&limit=10");

    assert.equal(calls[1].method, "GET");
    assert.equal(calls[1].url, "https://dify.example/console/api/account/personal-access-tokens/pat-1");

    assert.equal(calls[2].method, "POST");
    assert.equal(calls[2].url, "https://dify.example/console/api/account/personal-access-tokens");
    assert.equal(calls[2].headers["idempotency-key"], "idem-key-123");
    assert.equal(calls[2].headers["x-csrf-token"], "csrf-1");
    assert.deepEqual(JSON.parse(calls[2].body!), { name: "ci-bot", expiration: "90_days" });

    assert.equal(calls[3].method, "PATCH");
    assert.equal(calls[3].url, "https://dify.example/console/api/account/personal-access-tokens/pat-1");
    assert.deepEqual(JSON.parse(calls[3].body!), { name: "ci-bot-v2", version: 1 });

    assert.equal(calls[4].method, "DELETE");
    assert.equal(calls[4].url, "https://dify.example/console/api/account/personal-access-tokens/pat-1");

    assert.equal(
      calls[5].url,
      "https://dify.example/console/api/account/personal-access-token-resources?cursor=0&limit=20&keyword=wf&resource_type=app",
    );
    assert.equal(
      calls[6].url,
      "https://dify.example/console/api/account/personal-access-token-workspaces?cursor=10&limit=5&keyword=prod",
    );
  } finally {
    restore();
  }
});

test("pat.create and pat.revoke enforce confirm=true gate", async () => {
  const createRes = await runTool(find("pat.create"), { name: "agent-token" }, {});
  assert.equal(createRes.ok, false);
  if (!createRes.ok) assert.equal(createRes.error.code, "CONFIRM_REQUIRED");

  const revokeRes = await runTool(find("pat.revoke"), { token_id: "pat-1" }, {});
  assert.equal(revokeRes.ok, false);
  if (!revokeRes.ok) assert.equal(revokeRes.error.code, "CONFIRM_REQUIRED");
});

test("pat.update validates paired scope domains and version >= 1", async () => {
  const consoleClient = {
    updatePersonalAccessToken: async () => success(),
  };

  await assert.rejects(
    () =>
      find("pat.update").run(
        { token_id: "pat-1", name: "x", version: 1, resource_scope: { mode: "all", resources: [] } },
        ctx(consoleClient),
      ),
    (e: unknown) => e instanceof Error && /both resource_scope and workspace_scope/i.test(e.message),
  );

  await assert.rejects(
    () =>
      find("pat.update").run(
        { token_id: "pat-1", name: "x", version: 0 },
        ctx(consoleClient),
      ),
    (e: unknown) => e instanceof Error && /version must be an integer >= 1/i.test(e.message),
  );
});

test("all 7 pat.* tools route to ConsoleClient", async () => {
  const log: string[] = [];
  const consoleClient = {
    listPersonalAccessTokens: async () => { log.push("list"); return success({ data: [] }); },
    getPersonalAccessToken: async (id: string) => { log.push(`get:${id}`); return success({ id }); },
    createPersonalAccessToken: async (b: Record<string, unknown>, k?: string) => {
      log.push(`create:${b.name}:${k ?? ""}`);
      return success({ secret: "dpat_secret" });
    },
    updatePersonalAccessToken: async (id: string, b: Record<string, unknown>) => {
      log.push(`update:${id}:v${b.version}`);
      return success({ id });
    },
    revokePersonalAccessToken: async (id: string) => { log.push(`revoke:${id}`); return success(null); },
    listPatResourceCandidates: async () => { log.push("resources"); return success({ items: [] }); },
    listPatWorkspaceCandidates: async () => { log.push("workspaces"); return success({ items: [] }); },
  };

  assert.ok((await find("pat.list").run({ page: 1, limit: 20 }, ctx(consoleClient))).ok);
  assert.ok((await find("pat.get").run({ token_id: "pat-1" }, ctx(consoleClient))).ok);
  assert.ok((await find("pat.create").run({ name: "ci", idempotency_key: "k1", confirm: true }, ctx(consoleClient))).ok);
  assert.ok((await find("pat.update").run({ token_id: "pat-1", name: "ci2", version: 2 }, ctx(consoleClient))).ok);
  assert.ok((await find("pat.revoke").run({ token_id: "pat-1", confirm: true }, ctx(consoleClient))).ok);
  assert.ok((await find("pat.resources").run({ resource_type: "app" }, ctx(consoleClient))).ok);
  assert.ok((await find("pat.workspaces").run({ keyword: "main" }, ctx(consoleClient))).ok);

  assert.deepEqual(log, [
    "list",
    "get:pat-1",
    "create:ci:k1",
    "update:pat-1:v2",
    "revoke:pat-1",
    "resources",
    "workspaces",
  ]);
});

test("OpenAPI PAT Bearer auth, DIFY_TOKEN fallback precedence, masking, and redaction", async () => {
  let authHeader = "";
  const restore = mockFetch(async (_url, init) => {
    const h = init?.headers as Record<string, string> | undefined;
    authHeader = h?.Authorization ?? "";
    return Response.json({ data: [] });
  });
  try {
    const client = new OpenapiClient("https://dify.example", "dpat_example_secret_1234");
    assert.ok((await client.listApps()).ok);
    assert.equal(authHeader, "Bearer dpat_example_secret_1234");
  } finally {
    restore();
  }

  assert.equal(maskToken("dpat_1234567890abcd"), "dpat...abcd");
  const redacted = redactArgs({ openapi_token: "dpat_secret", name: "ci" });
  assert.equal(redacted.openapi_token, "[redacted]");
  assert.equal(redacted.name, "ci");

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "difywf-pat-cfg-"));
  const prevHome = process.env.DIFYWF_HOME;
  const prevBase = process.env.DIFY_API_BASE;
  const prevOpenapi = process.env.DIFY_OPENAPI_TOKEN;
  const prevDifyToken = process.env.DIFY_TOKEN;
  try {
    process.env.DIFYWF_HOME = tmpHome;
    process.env.DIFY_API_BASE = "https://dify.example";
    fs.writeFileSync(
      path.join(tmpHome, "hosts.json"),
      JSON.stringify({ active_host: "https://dify.example", hosts: { "https://dify.example": { openapi_token: "stored_tok" } } }),
    );

    delete process.env.DIFY_OPENAPI_TOKEN;
    delete process.env.DIFY_TOKEN;
    assert.equal(resolveConfig({}).openapiToken, "stored_tok");

    process.env.DIFY_TOKEN = "dpat_from_dify_token";
    assert.equal(resolveConfig({}).openapiToken, "dpat_from_dify_token");

    process.env.DIFY_OPENAPI_TOKEN = "dpat_from_openapi_token";
    assert.equal(resolveConfig({}).openapiToken, "dpat_from_openapi_token");

    assert.equal(resolveConfig({ "openapi-token": "dpat_from_flag" }).openapiToken, "dpat_from_flag");
  } finally {
    if (prevHome === undefined) delete process.env.DIFYWF_HOME;
    else process.env.DIFYWF_HOME = prevHome;
    if (prevBase === undefined) delete process.env.DIFY_API_BASE;
    else process.env.DIFY_API_BASE = prevBase;
    if (prevOpenapi === undefined) delete process.env.DIFY_OPENAPI_TOKEN;
    else process.env.DIFY_OPENAPI_TOKEN = prevOpenapi;
    if (prevDifyToken === undefined) delete process.env.DIFY_TOKEN;
    else process.env.DIFY_TOKEN = prevDifyToken;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
