import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tools, type ToolCtx } from "../src/tools/registry.ts";
import { guideText } from "../src/tools/guide.ts";
import type { Result } from "../src/core/contract.ts";

const find = (name: string) => tools.find((tool) => tool.name === name)!;
const fakeCtx = (overrides: Partial<ToolCtx> = {}): ToolCtx => ({
  cfg: { baseUrl: "https://dify.example", openapiToken: "t", consoleToken: "t", workspaceId: "w" },
  openapi: null,
  console: null,
  ...overrides,
});

test("agent guide exposes the Dify compatibility contract", () => {
  const text = guideText("compatibility");
  assert.match(text, /dify-mcp 0\.3\.x/);
  assert.match(text, /1\.17\.x/);
  assert.match(text, /1\.16\.x/);
  assert.match(text, /Unsupported \(no legacy adapter\)/);
});

test("app.backup writes one DSL and manifest per app", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "difywf-backup-"));
  const client = {
    listApps: async (): Promise<Result<unknown>> => ({
      ok: true,
      data: {
        data: [
          { id: "app-1", name: "Prod Workflow", mode: "workflow" },
          { id: "app-2", name: "Support Chat", mode: "chat" },
        ],
        has_more: false,
      },
    }),
    exportDsl: async (id: string): Promise<Result<string>> => ({
      ok: true,
      data: `version: 0.7.0\nkind: app\nid: ${id}\n`,
    }),
  };

  const result = await find("app.backup").run(
    { path: dir, mode: "workflow" },
    fakeCtx({ console: client as never }),
  );
  assert.ok(result.ok);
  if (result.ok) assert.equal((result.data as Record<string, unknown>).app_count, 1);

  const file = path.join(dir, "Prod_Workflow-app-1.yml");
  assert.equal(readFileSync(file, "utf8"), "version: 0.7.0\nkind: app\nid: app-1\n");
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    app_count: number;
    files: Array<{ app_id: string; file: string }>;
  };
  assert.equal(manifest.app_count, 1);
  assert.deepEqual(manifest.files, [{ app_id: "app-1", name: "Prod Workflow", mode: "workflow", file: "Prod_Workflow-app-1.yml" }]);

  const overwrite = await find("app.backup").run(
    { path: dir, mode: "workflow" },
    fakeCtx({ console: client as never }),
  );
  assert.ok(!overwrite.ok);
  if (!overwrite.ok) assert.equal(overwrite.error.code, "USAGE_ERROR");

  const secret = await find("app.backup").run(
    { path: dir, include_secret: true },
    fakeCtx({ console: client as never }),
  );
  assert.ok(!secret.ok);
  if (!secret.ok) assert.equal(secret.error.code, "CONFIRM_REQUIRED");
});

test("app.restore dry-runs conflicts and then imports only new apps", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "difywf-restore-"));
  fs.writeFileSync(path.join(dir, "Existing-app-1.yml"), "version: 0.7.0\nkind: app\nname: Existing\n");
  fs.writeFileSync(path.join(dir, "New-app-2.yml"), "version: 0.7.0\nkind: app\nname: New\n");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    files: [
      { app_id: "app-1", name: "Existing", file: "Existing-app-1.yml" },
      { app_id: "app-2", name: "New", file: "New-app-2.yml" },
    ],
  }));

  const imports: string[] = [];
  const client = {
    listApps: async (): Promise<Result<unknown>> => ({
      ok: true,
      data: [{ id: "app-1", name: "Existing", mode: "workflow" }],
    }),
    importDsl: async (body: Record<string, unknown>): Promise<Result<unknown>> => {
      imports.push(String(body.yaml_content));
      return { ok: true, data: { app_id: "new-app" } };
    },
    confirmImport: async (): Promise<Result<unknown>> => {
      throw new Error("import completed immediately");
    },
  };
  const ctx = fakeCtx({ console: client as never });

  const plan = await find("app.restore").run({ path: dir, dry_run: true }, ctx);
  assert.ok(plan.ok);
  if (plan.ok) {
    const data = plan.data as Record<string, unknown[]>;
    assert.equal(data.imported.length, 1);
    assert.deepEqual(data.skipped, [{ file: "Existing-app-1.yml", reason: "name_conflict", name: "Existing" }]);
  }
  assert.deepEqual(imports, []);

  const restored = await find("app.restore").run({ path: dir, confirm: true }, ctx);
  assert.ok(restored.ok);
  if (restored.ok) {
    const data = restored.data as Record<string, unknown[]>;
    assert.equal(data.imported.length, 1);
    assert.equal(data.skipped.length, 1);
    assert.equal(data.failed.length, 0);
  }
  assert.deepEqual(imports, ["version: 0.7.0\nkind: app\nname: New\n"]);
});
