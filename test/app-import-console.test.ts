import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsoleClient } from "../src/api/console.ts";

test("ConsoleClient app import methods use the Dify Console API contract", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ status: "completed", app_id: "app-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new ConsoleClient("https://dify.example", "token");
    await client.importDsl({ mode: "yaml-content", yaml_content: "kind: app" });
    await client.confirmImport("import-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ["POST", "/console/api/apps/imports"],
    ["POST", "/console/api/apps/imports/import-1/confirm"],
  ]);
  assert.deepEqual(calls[1].body, {});
});
