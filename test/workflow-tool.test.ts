import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsoleClient } from "../src/api/console.ts";
import { err, ok } from "../src/core/contract.ts";
import { runTool, tools } from "../src/tools/registry.ts";

const startDraft = (...names: string[]): Record<string, unknown> => ({
  graph: {
    nodes: [{
      id: "start",
      data: { type: "start", variables: names.map((variable) => ({ variable, type: "text-input" })) },
    }],
    edges: [],
  },
});

test("ConsoleClient workflow-tool methods use the Dify Console API contract", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ result: "success", synced: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new ConsoleClient("https://dify.example", "token");
    await client.getWorkflowTool({ appId: "app-1" });
    await client.createWorkflowTool({ workflow_app_id: "app-1" });
    await client.updateWorkflowTool({ workflow_tool_id: "tool-1" });
    await client.deleteWorkflowTool("tool-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls[0].url, "https://dify.example/console/api/workspaces/current/tool-provider/workflow/get?workflow_app_id=app-1");
  assert.equal(calls[0].method, "GET");
  assert.deepEqual(calls.slice(1).map((call) => [call.method, new URL(call.url).pathname]), [
    ["POST", "/console/api/workspaces/current/tool-provider/workflow/create"],
    ["POST", "/console/api/workspaces/current/tool-provider/workflow/update"],
    ["POST", "/console/api/workspaces/current/tool-provider/workflow/delete"],
  ]);
  assert.deepEqual(calls[3].body, { workflow_tool_id: "tool-1" });
});

test("workflow-tool lookup normalizes Dify's Tool not found variants", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "Tool not found" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
  try {
    const result = await new ConsoleClient("https://dify.example", "token").getWorkflowTool({ appId: "app-1" });
    assert.ok(!result.ok);
    if (!result.ok) assert.equal(result.error.code, "NOT_FOUND");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refresh creates a missing provider and verifies readback", async () => {
  const client = new ConsoleClient("https://dify.example", "token");
  let reads = 0;
  let created: Record<string, unknown> | undefined;
  client.getWorkflowTool = async () => reads++ === 0
    ? err("NOT_FOUND", "Tool not found")
    : ok({ workflow_tool_id: "tool-1", workflow_app_id: "app-1", synced: true });
  client.getApp = async () => ok({ name: "123 child", description: "child workflow", icon: "\ud83e\udde9", icon_background: "#fff" });
  client.getDraft = async () => ok(startDraft("query"));
  client.createWorkflowTool = async (body) => {
    created = body;
    return ok({ result: "success" });
  };

  const result = await client.refreshWorkflowToolProvider("app-1");

  assert.ok(result.ok);
  if (result.ok) assert.equal((result.data as Record<string, unknown>).action, "created");
  assert.deepEqual(created, {
    workflow_app_id: "app-1",
    name: "tool_123_child",
    label: "123 child",
    description: "child workflow",
    icon: { content: "\ud83e\udde9", background: "#fff" },
    parameters: [{ name: "query", description: "", form: "form" }],
    labels: [],
    privacy_policy: "",
  });
});

test("refresh updates a stale provider while preserving its authored metadata", async () => {
  const client = new ConsoleClient("https://dify.example", "token");
  const before = {
    workflow_tool_id: "tool-1",
    workflow_app_id: "app-1",
    synced: false,
    name: "stable_name",
    label: "Stable label",
    description: "kept",
    icon: { content: "x", background: "#000" },
    parameters: [{ name: "query", description: "kept input", form: "llm" }],
    tool: { labels: ["managed"] },
    privacy_policy: "policy",
  };
  let reads = 0;
  let updated: Record<string, unknown> | undefined;
  client.getWorkflowTool = async () => reads++ === 0 ? ok(before) : ok({ ...before, synced: true });
  client.getApp = async () => ok({ name: "renamed app" });
  client.getDraft = async () => ok(startDraft("query", "new_input"));
  client.updateWorkflowTool = async (body) => {
    updated = body;
    return ok({ result: "success" });
  };

  const result = await client.refreshWorkflowToolProvider("app-1");

  assert.ok(result.ok);
  if (result.ok) assert.equal((result.data as Record<string, unknown>).action, "updated");
  assert.deepEqual(updated, {
    workflow_tool_id: "tool-1",
    name: "stable_name",
    label: "Stable label",
    description: "kept",
    icon: { content: "x", background: "#000" },
    parameters: [
      { name: "query", description: "kept input", form: "llm" },
      { name: "new_input", description: "", form: "form" },
    ],
    labels: ["managed"],
    privacy_policy: "policy",
  });
});

test("refresh performs zero writes when the provider is already synced", async () => {
  const client = new ConsoleClient("https://dify.example", "token");
  client.getWorkflowTool = async () => ok({ workflow_tool_id: "tool-1", synced: true });
  client.getApp = async () => { throw new Error("must not read app"); };
  client.getDraft = async () => { throw new Error("must not read draft"); };

  const result = await client.refreshWorkflowToolProvider("app-1");

  assert.ok(result.ok);
  if (result.ok) assert.equal((result.data as Record<string, unknown>).action, "unchanged");
});

test("refresh fails closed when readback remains stale", async () => {
  const client = new ConsoleClient("https://dify.example", "token");
  const stale = { workflow_tool_id: "tool-1", workflow_app_id: "app-1", synced: false };
  client.getWorkflowTool = async () => ok(stale);
  client.getApp = async () => ok({ name: "child" });
  client.getDraft = async () => ok(startDraft("query"));
  client.updateWorkflowTool = async () => ok({ result: "success" });

  const result = await client.refreshWorkflowToolProvider("app-1");

  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, "DSL_VERSION_MISMATCH");
});

test("workflow.tool_refresh_provider is confirm-gated", async () => {
  const tool = tools.find((item) => item.name === "workflow.tool_refresh_provider");
  assert.ok(tool);
  const result = await runTool(tool!, { app_id: "app-1" }, { _surface: "mcp" });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, "CONFIRM_REQUIRED");
});
