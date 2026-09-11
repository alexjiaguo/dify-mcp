import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsoleClient } from "../src/api/console.ts";
import { tools, runTool } from "../src/tools/registry.ts";

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

test("knowledge.* tools are registered with expected confirm gates", () => {
  const names = tools.filter((t) => t.name.startsWith("knowledge.")).map((t) => t.name).sort();
  assert.deepEqual(names, [
    "knowledge.add_segment",
    "knowledge.create_dataset",
    "knowledge.create_document",
    "knowledge.delete_dataset",
    "knowledge.delete_document",
    "knowledge.delete_segments",
    "knowledge.get_dataset",
    "knowledge.get_document",
    "knowledge.hit_testing",
    "knowledge.indexing_status",
    "knowledge.list_datasets",
    "knowledge.list_documents",
    "knowledge.list_segments",
    "knowledge.rename_document",
    "knowledge.update_dataset",
    "knowledge.update_segment",
  ]);
  for (const name of [
    "knowledge.delete_dataset",
    "knowledge.delete_document",
    "knowledge.delete_segments",
  ]) {
    assert.equal(find(name).confirm, true);
  }
});

test("knowledge.create_document builds upload_file KnowledgeConfig from file_ids", async () => {
  const seen: { url?: string; body?: unknown } = {};
  const restore = mockFetch((url, init) => {
    seen.url = url;
    seen.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify({ document: { id: "doc-1" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const client = new ConsoleClient("https://dify.example", "tok");
    const result = await client.createDocument("ds-1", {
      indexing_technique: "high_quality",
      data_source: {
        info_list: {
          data_source_type: "upload_file",
          file_info_list: { file_ids: ["f1"] },
        },
      },
      process_rule: { mode: "automatic" },
    });
    assert.equal(result.ok, true);
    assert.match(seen.url ?? "", /\/datasets\/ds-1\/documents$/);
    assert.equal((seen.body as { indexing_technique: string }).indexing_technique, "high_quality");
  } finally {
    restore();
  }
});

test("knowledge.create_document tool requires body or file_ids", async () => {
  const result = await runTool(
    find("knowledge.create_document"),
    { dataset_id: "ds-1" },
    {
      _surface: "test",
      "base-url": "https://dify.example",
      "console-token": "t",
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "USAGE_ERROR");
});

test("knowledge.delete_dataset is confirm-gated via runTool", async () => {
  const result = await runTool(find("knowledge.delete_dataset"), { dataset_id: "ds-1" }, { _surface: "test" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CONFIRM_REQUIRED");
});

test("workspace invite/role/remove tools are confirm-gated", async () => {
  for (const name of ["workspace.invite_members", "workspace.update_member_role", "workspace.remove_member"]) {
    assert.equal(find(name).confirm, true);
    const result = await runTool(find(name), { emails: ["a@b.c"], role: "normal", member_id: "m1" }, { _surface: "test" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "CONFIRM_REQUIRED");
  }
});

test("workspace.invite_members posts invite-email payload", async () => {
  const seen: { url?: string; method?: string; body?: unknown } = {};
  const restore = mockFetch((url, init) => {
    seen.url = url;
    seen.method = init?.method ?? "POST";
    seen.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify({ result: "success" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const client = new ConsoleClient("https://dify.example", "tok");
    const result = await client.inviteMembers({ emails: ["a@example.com"], role: "editor", language: "en-US" });
    assert.equal(result.ok, true);
    assert.match(seen.url ?? "", /\/members\/invite-email$/);
    assert.deepEqual(seen.body, { emails: ["a@example.com"], role: "editor", language: "en-US" });
  } finally {
    restore();
  }
});
