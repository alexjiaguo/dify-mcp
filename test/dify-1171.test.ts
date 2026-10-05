import { test } from "node:test";
import assert from "node:assert/strict";
import { tools, runTool } from "../src/tools/registry.ts";
import { type Result } from "../src/core/contract.ts";

const find = (name: string) => tools.find((t) => t.name === name)!;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const mockFlags = {
  "base-url": "https://cloud.dify.ai",
  "console-token": "test-token",
  _surface: "cli",
};

test("18 new Dify 1.17.1 tools are all registered", () => {
  const expected = [
    "mcp.list",
    "mcp.get",
    "mcp.create",
    "mcp.update",
    "mcp.delete",
    "mcp.refresh_tools",
    "app.mcp_server_get",
    "app.mcp_server_set",
    "app.mcp_server_rotate",
    "skill.list",
    "skill.get",
    "skill.versions",
    "skill.references",
    "skill.import",
    "skill.publish",
    "skill.delete",
    "skill.agent_bindings",
    "skill.set_agent_bindings",
  ];
  for (const name of expected) {
    const t = find(name);
    assert.ok(t, `tool '${name}' not found`);
    assert.equal(t.needs, "console", `'${name}' must require console`);
  }
});

test("mcp.* tools interact correctly with Dify console endpoints", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const restore = mockFetch(async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ result: "success" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    // 1. mcp.list
    const rList = await runTool(find("mcp.list"), {}, mockFlags);
    assert.ok(rList.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/tools/mcp");
    assert.equal(calls[calls.length - 1].method, "GET");

    // 2. mcp.get
    const rGet = await runTool(find("mcp.get"), { provider_id: "prov-1" }, mockFlags);
    assert.ok(rGet.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/tool-provider/mcp/tools/prov-1");
    assert.equal(calls[calls.length - 1].method, "GET");

    // 3. mcp.create
    const rCreate = await runTool(find("mcp.create"), {
      name: "Slack",
      server_url: "https://slack.mcp/sse",
      server_identifier: "slack_mcp",
    }, mockFlags);
    assert.ok(rCreate.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/tool-provider/mcp");
    assert.equal(calls[calls.length - 1].method, "POST");
    assert.deepEqual(calls[calls.length - 1].body, {
      name: "Slack",
      server_url: "https://slack.mcp/sse",
      server_identifier: "slack_mcp",
    });

    // 4. mcp.update
    const rUpdate = await runTool(find("mcp.update"), {
      provider_id: "prov-1",
      name: "Slack V2",
    }, mockFlags);
    assert.ok(rUpdate.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/tool-provider/mcp");
    assert.equal(calls[calls.length - 1].method, "PUT");
    assert.deepEqual(calls[calls.length - 1].body, {
      provider_id: "prov-1",
      name: "Slack V2",
    });

    // 5. mcp.delete (requires confirm)
    const rDelBlocked = await runTool(find("mcp.delete"), { provider_id: "prov-1" }, mockFlags);
    assert.ok(!rDelBlocked.ok);
    if (!rDelBlocked.ok) assert.equal(rDelBlocked.error.code, "CONFIRM_REQUIRED");

    const rDel = await runTool(find("mcp.delete"), { provider_id: "prov-1", confirm: true }, mockFlags);
    assert.ok(rDel.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/tool-provider/mcp");
    assert.equal(calls[calls.length - 1].method, "DELETE");
    assert.deepEqual(calls[calls.length - 1].body, { provider_id: "prov-1" });

    // 6. mcp.refresh_tools
    const rRefresh = await runTool(find("mcp.refresh_tools"), { provider_id: "prov-1" }, mockFlags);
    assert.ok(rRefresh.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/tool-provider/mcp/update/prov-1");
    assert.equal(calls[calls.length - 1].method, "GET");
  } finally {
    restore();
  }
});

test("app.mcp_server_* tools manage App MCP endpoint with computed URL and upsert", async () => {
  let serverRecord: Record<string, unknown> | null = null;
  const restore = mockFetch(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/server") && method === "GET") {
      if (!serverRecord) {
        return new Response(JSON.stringify({ code: "not_found", message: "Server not found" }), { status: 404 });
      }
      return new Response(JSON.stringify(serverRecord), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/server") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      serverRecord = { id: "srv-123", server_code: "code-abc", ...body };
      return new Response(JSON.stringify(serverRecord), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/server") && method === "PUT") {
      const body = JSON.parse(String(init?.body));
      serverRecord = { ...serverRecord, ...body };
      return new Response(JSON.stringify(serverRecord), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/server/refresh") && method === "POST") {
      serverRecord = { ...serverRecord, server_code: "code-new" };
      return new Response(JSON.stringify(serverRecord), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  try {
    // 1. Initial get when not created yet -> 404
    const rGetEmpty = await runTool(find("app.mcp_server_get"), { app_id: "app-1" }, mockFlags);
    assert.ok(!rGetEmpty.ok);

    // 2. Upsert (set) creates the server when missing
    const rSetCreate = await runTool(find("app.mcp_server_set"), {
      app_id: "app-1",
      description: "My MCP App",
      parameters: { query: { type: "string" } },
      status: "active",
    }, mockFlags);
    assert.ok(rSetCreate.ok);
    const createData = rSetCreate.data as Record<string, unknown>;
    assert.equal(createData.id, "srv-123");
    assert.equal(createData.server_code, "code-abc");
    assert.equal(createData.url, "https://cloud.dify.ai/mcp/server/code-abc/mcp");

    // 3. Get existing server
    const rGet = await runTool(find("app.mcp_server_get"), { app_id: "app-1" }, mockFlags);
    assert.ok(rGet.ok);
    const getData = rGet.data as Record<string, unknown>;
    assert.equal(getData.url, "https://cloud.dify.ai/mcp/server/code-abc/mcp");

    // 4. Upsert (set) updates when already existing
    const rSetUpdate = await runTool(find("app.mcp_server_set"), {
      app_id: "app-1",
      description: "Updated Description",
    }, mockFlags);
    assert.ok(rSetUpdate.ok);
    const updateData = rSetUpdate.data as Record<string, unknown>;
    assert.equal(updateData.description, "Updated Description");

    // 5. Rotate is confirm-gated
    const rRotateBlocked = await runTool(find("app.mcp_server_rotate"), { app_id: "app-1" }, mockFlags);
    assert.ok(!rRotateBlocked.ok);
    if (!rRotateBlocked.ok) assert.equal(rRotateBlocked.error.code, "CONFIRM_REQUIRED");

    // 6. Rotate regenerates server code and updates URL
    const rRotate = await runTool(find("app.mcp_server_rotate"), { app_id: "app-1", confirm: true }, mockFlags);
    assert.ok(rRotate.ok);
    const rotateData = rRotate.data as Record<string, unknown>;
    assert.equal(rotateData.server_code, "code-new");
    assert.equal(rotateData.url, "https://cloud.dify.ai/mcp/server/code-new/mcp");
  } finally {
    restore();
  }
});

test("skill.* tools manage workspace skills and agent bindings", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const restore = mockFetch(async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body instanceof FormData ? "multipart" : init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ result: "success" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    // 1. skill.list
    const rList = await runTool(find("skill.list"), { keyword: "search", page: 1, limit: 10 }, mockFlags);
    assert.ok(rList.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/skills?page=1&limit=10&keyword=search");

    // 2. skill.get
    const rGet = await runTool(find("skill.get"), { skill_id: "sk-1" }, mockFlags);
    assert.ok(rGet.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/skills/sk-1");

    // 3. skill.versions
    const rVersions = await runTool(find("skill.versions"), { skill_id: "sk-1" }, mockFlags);
    assert.ok(rVersions.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/skills/sk-1/versions");

    // 4. skill.references
    const rRefs = await runTool(find("skill.references"), { skill_id: "sk-1" }, mockFlags);
    assert.ok(rRefs.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/skills/sk-1/references");

    // 5. skill.import
    const rImport = await runTool(find("skill.import"), {
      file: { name: "custom_skill.zip", content_b64: Buffer.from("dummy").toString("base64") },
    }, mockFlags);
    assert.ok(rImport.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/skills/import");
    assert.equal(calls[calls.length - 1].method, "POST");
    assert.equal(calls[calls.length - 1].body, "multipart");

    // 6. skill.publish
    const rPub = await runTool(find("skill.publish"), { skill_id: "sk-1", publish_note: "v1.0.0" }, mockFlags);
    assert.ok(rPub.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/skills/sk-1/publish");
    assert.deepEqual(calls[calls.length - 1].body, { publish_note: "v1.0.0" });

    // 7. skill.delete (confirm-gated)
    const rDelBlocked = await runTool(find("skill.delete"), { skill_id: "sk-1" }, mockFlags);
    assert.ok(!rDelBlocked.ok);
    if (!rDelBlocked.ok) assert.equal(rDelBlocked.error.code, "CONFIRM_REQUIRED");

    const rDel = await runTool(find("skill.delete"), { skill_id: "sk-1", confirmation_name: "custom_skill", confirm: true }, mockFlags);
    assert.ok(rDel.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/skills/sk-1");
    assert.equal(calls[calls.length - 1].method, "DELETE");
    assert.deepEqual(calls[calls.length - 1].body, { confirmation_name: "custom_skill" });

    // 8. skill.agent_bindings
    const rBindings = await runTool(find("skill.agent_bindings"), { agent_id: "ag-1" }, mockFlags);
    assert.ok(rBindings.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/agents/ag-1/skills");

    // 9. skill.set_agent_bindings (confirm-gated)
    const rSetBindingsBlocked = await runTool(find("skill.set_agent_bindings"), { agent_id: "ag-1", skill_ids: ["sk-1", "sk-2"] }, mockFlags);
    assert.ok(!rSetBindingsBlocked.ok);
    if (!rSetBindingsBlocked.ok) assert.equal(rSetBindingsBlocked.error.code, "CONFIRM_REQUIRED");

    const rSetBindings = await runTool(find("skill.set_agent_bindings"), { agent_id: "ag-1", skill_ids: ["sk-1", "sk-2"], confirm: true }, mockFlags);
    assert.ok(rSetBindings.ok);
    assert.equal(calls[calls.length - 1].url, "https://cloud.dify.ai/console/api/workspaces/current/agents/ag-1/skills");
    assert.equal(calls[calls.length - 1].method, "PUT");
    assert.deepEqual(calls[calls.length - 1].body, { skill_ids: ["sk-1", "sk-2"] });
  } finally {
    restore();
  }
});
