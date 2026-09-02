import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsoleClient } from "../src/api/console.ts";
import { ok } from "../src/core/contract.ts";
import { runTool, tools } from "../src/tools/registry.ts";

test("ConsoleClient app-tag methods use the Dify Console API contract", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new ConsoleClient("https://dify.example", "token");
    await client.listAppTags();
    await client.createAppTag("ndr-managed");
    await client.bindAppTag("app-1", "tag-1");
    await client.removeAppTagBinding("app-1", "tag-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ["GET", "/console/api/tags"],
    ["POST", "/console/api/tags"],
    ["POST", "/console/api/tag-bindings"],
    ["POST", "/console/api/tag-bindings/remove"],
  ]);
  assert.equal(new URL(calls[0].url).searchParams.get("type"), "app");
  assert.deepEqual(calls[1].body, { name: "ndr-managed", type: "app" });
  assert.deepEqual(calls[2].body, { tag_ids: ["tag-1"], target_id: "app-1", type: "app" });
  assert.deepEqual(calls[3].body, { tag_ids: ["tag-1"], target_id: "app-1", type: "app" });
});

test("ensureAppTag binds an existing exact-name tag and verifies readback", async () => {
  const client = new ConsoleClient("https://dify.example", "token");
  let reads = 0;
  let bound: [string, string] | undefined;
  client.getAppTags = async () => ok({
    app_id: "app-1",
    tags: reads++ === 0 ? [] : [{ id: "tag-1", name: "ndr-managed" }],
  });
  client.listAppTags = async () => ok([{ id: "tag-1", name: "ndr-managed" }]);
  client.createAppTag = async () => { throw new Error("must not create an existing tag"); };
  client.bindAppTag = async (appId, tagId) => {
    bound = [appId, tagId];
    return ok({ result: "success" });
  };

  const result = await client.ensureAppTag("app-1", "ndr-managed");

  assert.ok(result.ok);
  if (result.ok) assert.equal((result.data as Record<string, unknown>).action, "bound");
  assert.deepEqual(bound, ["app-1", "tag-1"]);
});

test("ensureAppTag performs zero writes when exact tag is already bound", async () => {
  const client = new ConsoleClient("https://dify.example", "token");
  client.getAppTags = async () => ok({ app_id: "app-1", tags: [{ id: "tag-1", name: "ndr-managed" }] });
  client.listAppTags = async () => { throw new Error("must not list workspace tags"); };

  const result = await client.ensureAppTag("app-1", "ndr-managed");

  assert.ok(result.ok);
  if (result.ok) assert.equal((result.data as Record<string, unknown>).action, "unchanged");
});

test("ensureAppTag fails closed when bind readback is missing", async () => {
  const client = new ConsoleClient("https://dify.example", "token");
  client.getAppTags = async () => ok({ app_id: "app-1", tags: [] });
  client.listAppTags = async () => ok([{ id: "tag-1", name: "ndr-managed" }]);
  client.bindAppTag = async () => ok({ result: "success" });

  const result = await client.ensureAppTag("app-1", "ndr-managed");

  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, "DSL_VERSION_MISMATCH");
});

test("app.ensure_tag is confirm-gated", async () => {
  const tool = tools.find((item) => item.name === "app.ensure_tag");
  assert.ok(tool);
  const result = await runTool(tool!, { app_id: "app-1", tag: "ndr-managed" }, { _surface: "mcp" });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, "CONFIRM_REQUIRED");
});

test("removeAppTag unbinds an exact-name tag and verifies readback", async () => {
  const client = new ConsoleClient("https://dify.example", "token");
  let reads = 0;
  let removed: [string, string] | undefined;
  client.getAppTags = async () => ok({
    app_id: "app-1",
    tags: reads++ === 0 ? [{ id: "tag-1", name: "workflow-beta-1.0" }] : [],
  });
  client.removeAppTagBinding = async (appId, tagId) => {
    removed = [appId, tagId];
    return ok({ result: "success" });
  };

  const result = await client.removeAppTag("app-1", "workflow-beta-1.0");

  assert.ok(result.ok);
  if (result.ok) assert.equal((result.data as Record<string, unknown>).action, "removed");
  assert.deepEqual(removed, ["app-1", "tag-1"]);
});

test("removeAppTag performs zero writes when the exact tag is absent", async () => {
  const client = new ConsoleClient("https://dify.example", "token");
  client.getAppTags = async () => ok({ app_id: "app-1", tags: [] });
  client.removeAppTagBinding = async () => { throw new Error("must not remove an absent tag"); };

  const result = await client.removeAppTag("app-1", "workflow-beta-1.0");

  assert.ok(result.ok);
  if (result.ok) assert.equal((result.data as Record<string, unknown>).action, "unchanged");
});

test("removeAppTag fails closed when unbind readback still contains the tag", async () => {
  const client = new ConsoleClient("https://dify.example", "token");
  client.getAppTags = async () => ok({
    app_id: "app-1",
    tags: [{ id: "tag-1", name: "workflow-beta-1.0" }],
  });
  client.removeAppTagBinding = async () => ok({ result: "success" });

  const result = await client.removeAppTag("app-1", "workflow-beta-1.0");

  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, "DSL_VERSION_MISMATCH");
});

test("app.remove_tag is confirm-gated", async () => {
  const tool = tools.find((item) => item.name === "app.remove_tag");
  assert.ok(tool);
  const result = await runTool(
    tool!,
    { app_id: "app-1", tag: "workflow-beta-1.0" },
    { _surface: "mcp" },
  );
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.error.code, "CONFIRM_REQUIRED");
});
