// Single source of truth: every operation is a Tool with a pure async run fn.
// CLI and MCP are thin adapters over this registry. Confirm-gated tools never
// prompt; they require confirm=true (CLI --yes) per call.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { err, ok, type Err, type Result } from "../core/contract.ts";
import { maskToken, resolveConfig, type Config, type Flags } from "../core/config.ts";
import { OpenapiClient } from "../api/openapi.ts";
import { ConsoleClient } from "../api/console.ts";
import { validateGraph, type Graph, type GraphEdge } from "../graph/validate.ts";
import { guideText } from "./guide.ts";
import { refreshConsoleCookies, storeCookies } from "../core/auth.ts";

export type ToolCtx = { cfg: Config; openapi: OpenapiClient | null; console: ConsoleClient | null };
export type Tool = {
  name: string;
  summary: string;
  schema: Record<string, unknown>;
  needs?: "openapi" | "console";
  confirm?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<Result<unknown>>;
};

export class ToolError extends Error {
  code: Err["code"];
  retryable: boolean;
  details?: unknown;
  constructor(code: Err["code"], message: string, retryable = false, details?: unknown) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function makeCtx(flags: Flags): ToolCtx {
  const cfg = resolveConfig(flags);
  const refreshCb = cfg.consoleCookies
    ? async (cookies: Record<string, string>): Promise<Record<string, string> | null> => {
        const r = await refreshConsoleCookies(cfg.baseUrl, cookies);
        if (r.ok) {
          storeCookies(cfg.baseUrl, r.data);
          return r.data;
        }
        return null;
      }
    : undefined;
  return {
    cfg,
    openapi: cfg.baseUrl && cfg.openapiToken ? new OpenapiClient(cfg.baseUrl, cfg.openapiToken) : null,
    console:
      cfg.baseUrl && (cfg.consoleToken || cfg.consoleCookies)
        ? new ConsoleClient(cfg.baseUrl, cfg.consoleToken, cfg.consoleCookies, refreshCb)
        : null,
  };
}

function needClient(ctx: ToolCtx, kind: "openapi" | "console"): OpenapiClient | ConsoleClient {
  const client = kind === "openapi" ? ctx.openapi : ctx.console;
  if (!ctx.cfg.baseUrl) {
    throw new ToolError("USAGE_ERROR", "no base URL; pass --base-url, set DIFY_API_BASE, or run `difywf auth login`");
  }
  if (!client) {
    const envName = kind === "openapi" ? "DIFY_OPENAPI_TOKEN" : "DIFY_CONSOLE_TOKEN";
    throw new ToolError("AUTH_REQUIRED", `no ${kind} token; set ${envName} or run \`difywf auth login[-console]\``);
  }
  return client;
}

// Prefer the console (cookie-auth) surface; fall back to OpenAPI. Used by tools
// both surfaces support (apps list/get/export, workspaces) so a user with only
// console cookies isn't blocked by a missing OpenAPI management token.
function clientAny(ctx: ToolCtx): OpenapiClient | ConsoleClient {
  const c = ctx.console ?? ctx.openapi;
  if (!c) {
    throw new ToolError("AUTH_REQUIRED", "no console or openapi credential; run `difywf auth login[-console]` or `difywf auth login`");
  }
  return c;
}

const S = (desc: string) => ({ type: "string", description: desc });
const O = (desc: string) => ({ type: "object", description: desc });
const B = (desc: string) => ({ type: "boolean", description: desc });
const CONFIRM = B("required for destructive ops; pass true (CLI --yes) to proceed");

export const tools: Tool[] = [
  {
    name: "agent.guide",
    summary: "Self-onboarding playbook for agents: golden path, node types, error codes, safety rules.",
    schema: { type: "object", properties: { section: S("overview|quickstart|nodes|errors|safety|all") } },
    run: async (args) => ok(guideText(typeof args.section === "string" ? args.section : undefined)),
  },
  {
    name: "auth.status",
    summary: "Show resolved base URL, workspace, and which tokens are configured (masked).",
    schema: { type: "object", properties: {} },
    run: async (_args, ctx) =>
      ok({
        base_url: ctx.cfg.baseUrl || null,
        workspace: ctx.cfg.workspaceId ?? null,
        openapi_token: maskToken(ctx.cfg.openapiToken),
        console_token: maskToken(ctx.cfg.consoleToken),
        console_cookies: ctx.cfg.consoleCookies ? Object.keys(ctx.cfg.consoleCookies) : null,
      }),
  },
  {
    name: "app.list",
    summary: "List apps in the workspace.",
    needs: "openapi",
    schema: { type: "object", properties: { page: { type: "number" }, limit: { type: "number" }, mode: S("filter by app mode"), name: S("search by name") } },
    run: async (args, ctx) =>
      (clientAny(ctx)).listApps({
        page: num(args.page), limit: num(args.limit),
        mode: str(args.mode), name: str(args.name),
      }),
  },
  {
    name: "app.get",
    summary: "Describe one app.",
    needs: "openapi",
    schema: { type: "object", properties: { app_id: { ...S("app uuid"), ...{ } } }, required: ["app_id"] },
    run: async (args, ctx) => (clientAny(ctx)).getApp(req(args, "app_id")),
  },
  {
    name: "app.create",
    summary: "Create an app. mode: chat | agent-chat | advanced-chat | workflow | completion.",
    needs: "console",
    schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["chat", "agent-chat", "advanced-chat", "workflow", "completion"] },
        name: S("app name"), description: S("max 400 chars"), icon: S("emoji"), icon_type: S("emoji|image"), icon_background: S("hex color"),
      },
      required: ["mode", "name"],
    },
    run: async (args, ctx) =>
      (needClient(ctx, "console") as ConsoleClient).createApp(pick(args, ["mode", "name", "description", "icon", "icon_type", "icon_background"])),
  },
  {
    name: "app.update",
    summary: "Update app metadata (name, description, icon).",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), name: S(""), description: S(""), icon: S(""), icon_type: S(""), icon_background: S("") }, required: ["app_id"] },
    run: async (args, ctx) =>
      (needClient(ctx, "console") as ConsoleClient).updateApp(req(args, "app_id"), pick(args, ["name", "description", "icon", "icon_type", "icon_background"])),
  },
  {
    name: "app.list_tags",
    summary: "List the exact tags currently bound to one app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (args, ctx) =>
      (needClient(ctx, "console") as ConsoleClient).getAppTags(req(args, "app_id")),
  },
  {
    name: "app.ensure_tag",
    summary: "Create an app tag if needed, bind it to an app, and verify exact-name readback. Requires confirm=true.",
    needs: "console",
    confirm: true,
    schema: {
      type: "object",
      properties: { app_id: S("app uuid"), tag: S("exact app tag name"), confirm: CONFIRM },
      required: ["app_id", "tag", "confirm"],
    },
    run: async (args, ctx) =>
      (needClient(ctx, "console") as ConsoleClient).ensureAppTag(req(args, "app_id"), req(args, "tag")),
  },
  {
    name: "app.remove_tag",
    summary: "Unbind one exact-name tag from an app and verify readback. Requires confirm=true.",
    needs: "console",
    confirm: true,
    schema: {
      type: "object",
      properties: { app_id: S("app uuid"), tag: S("exact app tag name"), confirm: CONFIRM },
      required: ["app_id", "tag", "confirm"],
    },
    run: async (args, ctx) =>
      (needClient(ctx, "console") as ConsoleClient).removeAppTag(req(args, "app_id"), req(args, "tag")),
  },
  {
    name: "app.delete",
    summary: "Delete an app. Destructive; requires confirm=true.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), confirm: CONFIRM }, required: ["app_id", "confirm"] },
    run: async (args, ctx) => (needClient(ctx, "console") as ConsoleClient).deleteApp(req(args, "app_id")),
  },
  {
    name: "app.export",
    summary: "Export an app as DSL (YAML string).",
    needs: "openapi",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (args, ctx) => (clientAny(ctx)).exportDsl(req(args, "app_id")),
  },
  {
    name: "workflow.get_draft",
    summary: "Get the draft workflow graph, features, variables, and current hash.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (args, ctx) => (needClient(ctx, "console") as ConsoleClient).getDraft(req(args, "app_id")),
  },
  {
    name: "workflow.node_defaults",
    summary: "Get the default config schema for one node type (or all). Call before authoring nodes.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), node_type: S("e.g. llm, code, if-else") }, required: ["app_id"] },
    run: async (args, ctx) => (needClient(ctx, "console") as ConsoleClient).nodeDefaults(req(args, "app_id"), str(args.node_type)),
  },
  {
    name: "workflow.validate",
    summary: "Offline graph validation: structure, required fields, variable refs, connectivity, cycles.",
    schema: {
      type: "object",
      properties: {
        graph: O("the graph object {nodes, edges}"),
        graph_json: S("graph as a JSON string"),
        app_id: S("optional; fetch server node defaults for per-type schema checks"),
      },
    },
    run: async (args, ctx) => {
      const graph = parseGraphArg(args);
      let defaults: Record<string, unknown> | undefined;
      if (str(args.app_id) && ctx.console) {
        const d = await ctx.console.nodeDefaults(str(args.app_id)!);
        if (d.ok) defaults = defaultsToMap(d.data);
      }
      const issues = validateGraph(graph, { defaults });
      const errors = issues.filter((i) => i.level === "error");
      return ok({ valid: errors.length === 0, error_count: errors.length, warning_count: issues.length - errors.length, issues });
    },
  },
  {
    name: "workflow.sync_draft",
    summary: "Validate and save the draft graph. Supports dry_run diff. Optimistic-concurrency via hash.",
    needs: "console",
    schema: {
      type: "object",
      properties: {
        app_id: S("app uuid"), graph: O("{nodes, edges}"), features: O("app features"),
        environment_variables: { type: "array" }, conversation_variables: { type: "array" },
        hash: S("current draft hash; fetched automatically when omitted"),
        dry_run: B("validate + return diff without saving"),
      },
      required: ["app_id", "graph"],
    },
    run: async (args, ctx) => {
      const client = needClient(ctx, "console") as ConsoleClient;
      const graph = args.graph as Graph;
      const issues = validateGraph(graph).filter((i) => i.level === "error");
      if (issues.length > 0) return err("VALIDATION_FAILED", `${issues.length} error-level issue(s)`, { details: issues });
      const current = await client.getDraft(req(args, "app_id"));
      const currentGraph = current.ok ? ((current.data as Record<string, unknown>).graph as Graph | undefined) : undefined;
      if (args.dry_run === true) {
        return ok({ dry_run: true, diff: currentGraph ? graphDiff(currentGraph, graph) : null, issues });
      }
      const body: Record<string, unknown> = {
        graph,
        features: args.features ?? (current.ok ? (current.data as Record<string, unknown>).features : {}) ?? {},
        environment_variables: args.environment_variables ?? [],
        conversation_variables: args.conversation_variables ?? [],
        hash: str(args.hash) ?? (current.ok ? (current.data as Record<string, unknown>).hash : undefined),
      };
      return client.syncDraft(req(args, "app_id"), body);
    },
  },
  {
    name: "workflow.run_draft",
    summary: "Run the draft workflow with inputs; returns the SSE event list.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), inputs: O("input variables") }, required: ["app_id", "inputs"] },
    run: async (args, ctx) => (needClient(ctx, "console") as ConsoleClient).runDraft(req(args, "app_id"), obj(args, "inputs")),
  },
  {
    name: "workflow.run",
    summary: "Run the published app with inputs; returns the SSE event list.",
    needs: "openapi",
    schema: { type: "object", properties: { app_id: S("app uuid"), inputs: O("input variables") }, required: ["app_id", "inputs"] },
    run: async (args, ctx) => (needClient(ctx, "openapi") as OpenapiClient).runApp(req(args, "app_id"), obj(args, "inputs")),
  },
  {
    name: "workflow.events",
    summary: "Fetch the task event stream for a run.",
    needs: "openapi",
    schema: { type: "object", properties: { app_id: S("app uuid"), task_id: S("task id") }, required: ["app_id", "task_id"] },
    run: async (args, ctx) => (needClient(ctx, "openapi") as OpenapiClient).taskEvents(req(args, "app_id"), req(args, "task_id")),
  },
  {
    name: "workflow.run_node",
    summary: "Run a single draft node for debugging.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), node_id: S("node id"), inputs: O("input variables"), mode: { type: "string", enum: ["node", "iteration", "loop"] } }, required: ["app_id", "node_id", "inputs"] },
    run: async (args, ctx) =>
      (needClient(ctx, "console") as ConsoleClient).runNode(req(args, "app_id"), req(args, "node_id"), obj(args, "inputs"), (str(args.mode) as "node" | "iteration" | "loop") ?? "node"),
  },
  {
    name: "workflow.stop",
    summary: "Stop a running task.",
    needs: "openapi",
    schema: { type: "object", properties: { app_id: S("app uuid"), task_id: S("task id") }, required: ["app_id", "task_id"] },
    run: async (args, ctx) => (needClient(ctx, "openapi") as OpenapiClient).stopTask(req(args, "app_id"), req(args, "task_id")),
  },
  {
    name: "workflow.publish",
    summary: "Publish the current draft. Destructive; requires confirm=true.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), marked_name: S("version name, max 20 chars"), marked_comment: S("max 100 chars"), confirm: CONFIRM }, required: ["app_id", "confirm"] },
    run: async (args, ctx) =>
      (needClient(ctx, "console") as ConsoleClient).publish(req(args, "app_id"), pick(args, ["marked_name", "marked_comment"])),
  },
  {
    name: "workflow.tool_get",
    summary: "Get a workflow-as-tool provider by workflow app id or workflow tool id, including its synced status.",
    needs: "console",
    schema: {
      type: "object",
      properties: { app_id: S("workflow app uuid"), workflow_tool_id: S("workflow tool provider uuid") },
      anyOf: [{ required: ["app_id"] }, { required: ["workflow_tool_id"] }],
    },
    run: async (args, ctx) => {
      const appId = str(args.app_id);
      const toolId = str(args.workflow_tool_id);
      if (!appId && !toolId) throw new ToolError("USAGE_ERROR", "pass app_id or workflow_tool_id");
      return (needClient(ctx, "console") as ConsoleClient).getWorkflowTool({ appId, toolId });
    },
  },
  {
    name: "workflow.tool_refresh_provider",
    summary: "Create or update a workflow-as-tool provider so it targets the app's current published version; verifies synced=true.",
    needs: "console",
    confirm: true,
    schema: {
      type: "object",
      properties: { app_id: S("published workflow app uuid"), confirm: CONFIRM },
      required: ["app_id", "confirm"],
    },
    run: async (args, ctx) =>
      (needClient(ctx, "console") as ConsoleClient).refreshWorkflowToolProvider(req(args, "app_id")),
  },
  {
    name: "workflow.tool_delete",
    summary: "Delete a workflow-as-tool provider. Destructive; requires confirm=true.",
    needs: "console",
    confirm: true,
    schema: {
      type: "object",
      properties: { workflow_tool_id: S("workflow tool provider uuid"), confirm: CONFIRM },
      required: ["workflow_tool_id", "confirm"],
    },
    run: async (args, ctx) =>
      (needClient(ctx, "console") as ConsoleClient).deleteWorkflowTool(req(args, "workflow_tool_id")),
  },
  {
    name: "provider.list",
    summary: "List model providers configured in the workspace.",
    needs: "console",
    schema: { type: "object", properties: {} },
    run: async (_args, ctx) => (needClient(ctx, "console") as ConsoleClient).listProviders(),
  },
  {
    name: "provider.models",
    summary: "List models for one provider.",
    needs: "console",
    schema: { type: "object", properties: { provider: S("e.g. openai") }, required: ["provider"] },
    run: async (args, ctx) => (needClient(ctx, "console") as ConsoleClient).providerModels(req(args, "provider")),
  },
  {
    name: "provider.set_credentials",
    summary: "Set provider API credentials. Sensitive; requires confirm=true.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { provider: S("e.g. openai"), credentials: O("provider credential fields"), confirm: CONFIRM }, required: ["provider", "credentials", "confirm"] },
    run: async (args, ctx) =>
      (needClient(ctx, "console") as ConsoleClient).setProviderCredentials(req(args, "provider"), obj(args, "credentials")),
  },
  {
    name: "plugin.list",
    summary: "List installed plugins in the workspace.",
    needs: "console",
    schema: { type: "object", properties: {} },
    run: async (_args, ctx) => (needClient(ctx, "console") as ConsoleClient).listPlugins(),
  },
  // ============ P1: features, variables, versions ============
  {
    name: "workflow.get_features",
    summary: "Get the draft workflow features (file upload, suggested questions, TTS, STT, sensitive words).",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).getFeatures(req(a, "app_id")),
  },
  {
    name: "workflow.set_features",
    summary: "Replace the draft workflow features object.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), features: O("features object") }, required: ["app_id", "features"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).setFeatures(req(a, "app_id"), obj(a, "features")),
  },
  {
    name: "workflow.list_env_vars",
    summary: "List draft environment variables.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listEnvVars(req(a, "app_id")),
  },
  {
    name: "workflow.list_conv_vars",
    summary: "List draft conversation variables.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listConvVars(req(a, "app_id")),
  },
  {
    name: "workflow.create_variable",
    summary: "Create a draft environment/conversation variable.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), variable: O("variable definition {name, value_type, value, description}"), variable_type: S("env or conversation (default: env)") }, required: ["app_id", "variable"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).createVariable(req(a, "app_id"), obj(a, "variable"), str(a.variable_type)),
  },
  {
    name: "workflow.update_variable",
    summary: "Update a draft variable by id.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), variable_id: S("variable uuid"), variable: O("variable definition") }, required: ["app_id", "variable_id", "variable"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).updateVariable(req(a, "app_id"), req(a, "variable_id"), obj(a, "variable")),
  },
  {
    name: "workflow.delete_variable",
    summary: "Delete a draft variable. Destructive; requires confirm=true.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), variable_id: S("variable uuid"), confirm: CONFIRM }, required: ["app_id", "variable_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).deleteVariable(req(a, "app_id"), req(a, "variable_id")),
  },
  {
    name: "workflow.list_versions",
    summary: "List published workflow versions.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listVersions(req(a, "app_id")),
  },
  {
    name: "workflow.get_version",
    summary: "Get one published workflow version.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), workflow_id: S("workflow version id") }, required: ["app_id", "workflow_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).getVersion(req(a, "app_id"), req(a, "workflow_id")),
  },
  {
    name: "workflow.restore",
    summary: "Restore a published version as the draft. Overwrites the current draft; requires confirm=true.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), workflow_id: S("workflow version id"), confirm: CONFIRM }, required: ["app_id", "workflow_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).restoreVersion(req(a, "app_id"), req(a, "workflow_id")),
  },
  {
    name: "workflow.delete_version",
    summary: "Delete a published workflow version. Destructive; requires confirm=true.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), workflow_id: S("workflow version id"), confirm: CONFIRM }, required: ["app_id", "workflow_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).deleteVersion(req(a, "app_id"), req(a, "workflow_id")),
  },
  // ============ P1: app metadata + import ============
  {
    name: "app.copy",
    summary: "Duplicate an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).copyApp(req(a, "app_id")),
  },
  {
    name: "app.rename",
    summary: "Rename an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), name: S("new name") }, required: ["app_id", "name"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).renameApp(req(a, "app_id"), req(a, "name")),
  },
  {
    name: "app.set_icon",
    summary: "Set an app icon.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), icon: S("emoji or url"), icon_type: S("emoji|image"), icon_background: S("hex color") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).setAppIcon(req(a, "app_id"), pick(a, ["icon", "icon_type", "icon_background"])),
  },
  {
    name: "app.convert",
    summary: "Convert an app to workflow mode.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), name: S(""), icon: S(""), icon_type: S(""), icon_background: S("") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).convertApp(req(a, "app_id"), pick(a, ["name", "icon", "icon_type", "icon_background"])),
  },
  {
    name: "app.import",
    summary: "Import an app from DSL through console cookies or OpenAPI. Handles the 2-step confirm flow; requires confirm=true.",
    confirm: true,
    schema: { type: "object", properties: { workspace_id: S("target workspace; required only for OpenAPI fallback"), yaml: S("DSL YAML content"), yaml_url: S("...or YAML URL"), name: S("override name"), description: S(""), confirm: CONFIRM }, required: ["confirm"] },
    run: async (a, ctx) => {
      const body: Record<string, unknown> = {};
      if (str(a.yaml)) { body.mode = "yaml-content"; body.yaml_content = str(a.yaml); }
      else if (str(a.yaml_url)) { body.mode = "yaml-url"; body.yaml_url = str(a.yaml_url); }
      else throw new ToolError("USAGE_ERROR", "pass yaml (content) or yaml_url");
      if (str(a.name)) body.name = str(a.name);
      if (str(a.description)) body.description = str(a.description);
      const consoleClient = ctx.console;
      const openapiClient = ctx.openapi;
      if (!consoleClient && !openapiClient) {
        throw new ToolError("AUTH_REQUIRED", "app.import needs console cookies or an OpenAPI token");
      }
      const wid = str(a.workspace_id);
      if (!consoleClient && !wid) {
        throw new ToolError("USAGE_ERROR", "workspace_id is required for OpenAPI app.import");
      }
      const imp = consoleClient
        ? await consoleClient.importDsl(body)
        : await openapiClient!.importDsl(wid!, body);
      if (!imp.ok) return imp;
      const data = (imp.data ?? {}) as Record<string, unknown>;
      const importId = str(data.import_id) ?? str(data.id);
      const pending = data.status === "pending"
        || data.status === "completed_but_needs_plugin_install"
        || data.result === "pending"
        || (importId && data.result === undefined && !str(data.app_id));
      if (importId && pending) {
        const conf = consoleClient
          ? await consoleClient.confirmImport(importId)
          : await openapiClient!.confirmImport(wid!, importId);
        return conf.ok ? ok({ imported: true, confirmed: true, ...(conf.data as Record<string, unknown> ?? {}) }) : conf;
      }
      return ok({ imported: true, confirmed: false, ...data });
    },
  },
  {
    name: "app.check_deps",
    summary: "Check plugin dependencies for an app being imported.",
    needs: "openapi",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "openapi") as OpenapiClient).checkDependencies(req(a, "app_id")),
  },
  // ============ P1: triggers ============
  {
    name: "trigger.list",
    summary: "List triggers for an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listTriggers(req(a, "app_id")),
  },
  {
    name: "trigger.create",
    summary: "Create a trigger (schedule/webhook) for an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), trigger: O("trigger definition") }, required: ["app_id", "trigger"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).createTrigger(req(a, "app_id"), obj(a, "trigger")),
  },
  {
    name: "trigger.enable",
    summary: "Enable or disable triggers for an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), enabled: B("true to enable") }, required: ["app_id", "enabled"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).enableTrigger(req(a, "app_id"), { enabled: a.enabled === true }),
  },
  {
    name: "trigger.webhook",
    summary: "Get the webhook trigger URL for an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).webhookTrigger(req(a, "app_id")),
  },
  {
    name: "workflow.trigger_run",
    summary: "Run a specific trigger.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), inputs: O("trigger inputs") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).triggerRun(req(a, "app_id"), a.inputs && typeof a.inputs === "object" ? a.inputs as Record<string, unknown> : {}),
  },
  {
    name: "workflow.trigger_run_all",
    summary: "Run all triggers for an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).triggerRunAll(req(a, "app_id"), {}),
  },
  // ============ P1: workspaces, files, HITL (OpenAPI) ============
  {
    name: "workspace.list",
    summary: "List workspaces you can access.",
    needs: "openapi",
    schema: { type: "object", properties: {} },
    run: async (_a, ctx) => (clientAny(ctx)).listWorkspaces(),
  },
  {
    name: "workspace.get",
    summary: "Describe one workspace.",
    needs: "openapi",
    schema: { type: "object", properties: { workspace_id: S("workspace id") }, required: ["workspace_id"] },
    run: async (a, ctx) => (needClient(ctx, "openapi") as OpenapiClient).getWorkspace(req(a, "workspace_id")),
  },
  {
    name: "workspace.switch",
    summary: "Switch the active workspace.",
    needs: "openapi",
    schema: { type: "object", properties: { workspace_id: S("workspace id") }, required: ["workspace_id"] },
    run: async (a, ctx) => (needClient(ctx, "openapi") as OpenapiClient).switchWorkspace(req(a, "workspace_id")),
  },
  {
    name: "workspace.members",
    summary: "List workspace members.",
    needs: "openapi",
    schema: { type: "object", properties: { workspace_id: S("workspace id") }, required: ["workspace_id"] },
    run: async (a, ctx) => (needClient(ctx, "openapi") as OpenapiClient).listMembers(req(a, "workspace_id")),
  },
  {
    name: "file.upload",
    summary: "Upload a file for use in runs.",
    needs: "openapi",
    schema: { type: "object", properties: { app_id: S("app uuid"), file: O("file metadata/transfer payload") }, required: ["app_id", "file"] },
    run: async (a, ctx) => (needClient(ctx, "openapi") as OpenapiClient).uploadFile(req(a, "app_id"), obj(a, "file")),
  },
  {
    name: "workflow.hitl_preview",
    summary: "Preview a human-input form node before submission.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), node_id: S("human-input node id"), inputs: O("preview inputs") }, required: ["app_id", "node_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).hitlPreview(req(a, "app_id"), req(a, "node_id"), a.inputs && typeof a.inputs === "object" ? a.inputs as Record<string, unknown> : {}),
  },
  {
    name: "workflow.hitl_submit",
    summary: "Submit a human-input form node.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), node_id: S("human-input node id"), form_data: O("form values") }, required: ["app_id", "node_id", "form_data"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).hitlSubmit(req(a, "app_id"), req(a, "node_id"), obj(a, "form_data")),
  },
  // ============ P2: runs, stats ============
  {
    name: "runs.list",
    summary: "List workflow runs.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), page: { type: "number" }, limit: { type: "number" }, status: S("filter by status") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listRuns(req(a, "app_id"), { page: num(a.page), limit: num(a.limit), status: str(a.status) }),
  },
  {
    name: "runs.get",
    summary: "Get one workflow run.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), run_id: S("run id") }, required: ["app_id", "run_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).getRun(req(a, "app_id"), req(a, "run_id")),
  },
  {
    name: "runs.node_executions",
    summary: "Get node executions for a run.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), run_id: S("run id") }, required: ["app_id", "run_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).runNodeExecutions(req(a, "app_id"), req(a, "run_id")),
  },
  {
    name: "runs.export",
    summary: "Export a run's full trace.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), run_id: S("run id") }, required: ["app_id", "run_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).exportRun(req(a, "app_id"), req(a, "run_id")),
  },
  {
    name: "stats.daily_conversations",
    summary: "Daily conversation count stats.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), start: S("ISO start"), end: S("ISO end") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).stats(req(a, "app_id"), "daily-conversations", { start: str(a.start), end: str(a.end) }),
  },
  {
    name: "stats.daily_terminals",
    summary: "Daily terminal count stats.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), start: S("ISO start"), end: S("ISO end") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).stats(req(a, "app_id"), "daily-terminals", { start: str(a.start), end: str(a.end) }),
  },
  {
    name: "stats.token_costs",
    summary: "Token cost stats.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), start: S("ISO start"), end: S("ISO end") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).stats(req(a, "app_id"), "token-costs", { start: str(a.start), end: str(a.end) }),
  },
  {
    name: "stats.average_app_interactions",
    summary: "Average app interaction stats.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), start: S("ISO start"), end: S("ISO end") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).stats(req(a, "app_id"), "average-app-interactions", { start: str(a.start), end: str(a.end) }),
  },
  {
    name: "stats.online_users",
    summary: "List online users across workflows.",
    needs: "console",
    schema: { type: "object", properties: { page: { type: "number" }, limit: { type: "number" } } },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).onlineUsers({ page: num(a.page), limit: num(a.limit) }),
  },
  // ============ P2: comments, annotations, audio ============
  {
    name: "comment.list",
    summary: "List workflow comments.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listComments(req(a, "app_id")),
  },
  {
    name: "comment.add",
    summary: "Add a workflow comment.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), comment: O("comment body") }, required: ["app_id", "comment"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).addComment(req(a, "app_id"), obj(a, "comment")),
  },
  {
    name: "comment.resolve",
    summary: "Resolve a workflow comment.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), comment_id: S("comment id") }, required: ["app_id", "comment_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).resolveComment(req(a, "app_id"), req(a, "comment_id")),
  },
  {
    name: "annotation.list",
    summary: "List annotation replies.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listAnnotations(req(a, "app_id")),
  },
  {
    name: "annotation.add",
    summary: "Add an annotation reply.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), annotation: O("annotation body") }, required: ["app_id", "annotation"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).addAnnotation(req(a, "app_id"), obj(a, "annotation")),
  },
  {
    name: "annotation.delete",
    summary: "Delete an annotation. Destructive; requires confirm=true.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), annotation_id: S("annotation id"), confirm: CONFIRM }, required: ["app_id", "annotation_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).deleteAnnotation(req(a, "app_id"), req(a, "annotation_id")),
  },
  {
    name: "audio.transcribe",
    summary: "Transcribe audio to text (speech-to-text).",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), file: O("audio file reference") }, required: ["app_id", "file"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).audioToText(req(a, "app_id"), obj(a, "file")),
  },
  {
    name: "audio.synthesize",
    summary: "Synthesize audio from text (text-to-speech).",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), body: O("tts body: text, voice, ...") }, required: ["app_id", "body"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).textToAudio(req(a, "app_id"), obj(a, "body")),
  },
  {
    name: "audio.voices",
    summary: "List available TTS voices.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), language: S("language code, e.g. en-US or zh-Hans") }, required: ["app_id", "language"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listVoices(req(a, "app_id"), req(a, "language")),
  },
  // ============ P2: rag, explore, archive (read-only / run) ============
  {
    name: "rag.list_datasets",
    summary: "List RAG pipeline datasets.",
    needs: "console",
    schema: { type: "object", properties: {} },
    run: async (_a, ctx) => (needClient(ctx, "console") as ConsoleClient).listRagDatasets(),
  },
  {
    name: "rag.list_templates",
    summary: "List RAG pipeline templates.",
    needs: "console",
    schema: { type: "object", properties: {} },
    run: async (_a, ctx) => (needClient(ctx, "console") as ConsoleClient).listRagTemplates(),
  },
  {
    name: "explore.run",
    summary: "Run an installed (explore) app.",
    needs: "console",
    schema: { type: "object", properties: { installed_app_id: S("installed app id"), inputs: O("run inputs") }, required: ["installed_app_id", "inputs"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).runInstalledApp(req(a, "installed_app_id"), obj(a, "inputs")),
  },
  {
    name: "explore.stop",
    summary: "Stop a running installed app task.",
    needs: "console",
    schema: { type: "object", properties: { installed_app_id: S("installed app id"), task_id: S("task id") }, required: ["installed_app_id", "task_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).stopInstalledApp(req(a, "installed_app_id"), req(a, "task_id")),
  },
  {
    name: "archive.list",
    summary: "List workflow run archives.",
    needs: "console",
    schema: { type: "object", properties: { page: { type: "number" }, limit: { type: "number" } } },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listRunArchives({ page: num(a.page), limit: num(a.limit) }),
  },
  {
    name: "archive.download",
    summary: "Request a run archive download.",
    needs: "console",
    schema: { type: "object", properties: { body: O("download request body") }, required: ["body"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).downloadRunArchive(obj(a, "body")),
  },

  // ============ P3: annotation completion ============
  {
    name: "annotation.reply_action",
    summary: "Enable/disable annotation reply (enable triggers server-side indexing). confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), action: { type: "string", enum: ["enable", "disable"] }, confirm: CONFIRM }, required: ["app_id", "action", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).annotationReplyAction(req(a, "app_id"), req(a, "action")),
  },
  {
    name: "annotation.reply_status",
    summary: "Poll an annotation-reply enable/disable indexing job.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), action: S("enable|disable"), job_id: S("job id") }, required: ["app_id", "action", "job_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).annotationReplyStatus(req(a, "app_id"), req(a, "action"), req(a, "job_id")),
  },
  {
    name: "annotation.get_settings",
    summary: "Get annotation reply settings (score threshold, embedding provider/model).",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).getAnnotationSetting(req(a, "app_id")),
  },
  {
    name: "annotation.update_settings",
    summary: "Update annotation reply settings; re-indexes. confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), setting_id: S("annotation setting id"), settings: O("settings body"), confirm: CONFIRM }, required: ["app_id", "setting_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).updateAnnotationSetting(req(a, "app_id"), req(a, "setting_id"), obj(a, "settings")),
  },
  {
    name: "annotation.export",
    summary: "Export annotations (CSV).",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).exportAnnotations(req(a, "app_id")),
  },
  {
    name: "annotation.batch_import",
    summary: "Batch-import annotations from CSV (multipart file payload). confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), file: O("CSV file payload {name, content_b64}"), confirm: CONFIRM }, required: ["app_id", "file", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).batchImportAnnotations(req(a, "app_id"), obj(a, "file")),
  },
  {
    name: "annotation.import_status",
    summary: "Poll a batch-import job.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), job_id: S("job id") }, required: ["app_id", "job_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).annotationImportStatus(req(a, "app_id"), req(a, "job_id")),
  },
  {
    name: "annotation.hit_histories",
    summary: "List hit histories for one annotation.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), annotation_id: S("annotation id") }, required: ["app_id", "annotation_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).annotationHitHistories(req(a, "app_id"), req(a, "annotation_id")),
  },
  // ============ P3: RAG pipeline full lifecycle ============
  {
    name: "rag.create_dataset",
    summary: "Create a RAG pipeline dataset from DSL yaml_content.",
    needs: "console",
    schema: { type: "object", properties: { body: O("payload: {yaml_content, ...}") }, required: ["body"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).createRagDataset(obj(a, "body")),
  },
  {
    name: "rag.create_empty_dataset",
    summary: "Create an empty RAG pipeline dataset.",
    needs: "console",
    schema: { type: "object", properties: { body: O("payload: {name, description?, ...}") }, required: ["body"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).createEmptyRagDataset(obj(a, "body")),
  },
  {
    name: "rag.get_template",
    summary: "Get one RAG pipeline template.",
    needs: "console",
    schema: { type: "object", properties: { template_id: S("template id") }, required: ["template_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).getRagTemplate(req(a, "template_id")),
  },
  {
    name: "rag.get_draft",
    summary: "Get a RAG pipeline's draft workflow graph, features, hash.",
    needs: "console",
    schema: { type: "object", properties: { pipeline_id: S("pipeline id") }, required: ["pipeline_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).getRagDraft(req(a, "pipeline_id")),
  },
  {
    name: "rag.sync_draft",
    summary: "Save a RAG pipeline's draft graph. Pass graph, features, hash.",
    needs: "console",
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), graph: O("{nodes, edges}"), features: O("features"), hash: S("current draft hash") }, required: ["pipeline_id", "graph"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).syncRagDraft(req(a, "pipeline_id"), pick(a, ["graph", "features", "hash"])),
  },
  {
    name: "rag.node_defaults",
    summary: "Get default node config schema for a RAG pipeline (or all types).",
    needs: "console",
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), block_type: S("node type") }, required: ["pipeline_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).ragNodeDefaults(req(a, "pipeline_id"), str(a.block_type)),
  },
  {
    name: "rag.run_draft",
    summary: "Run a RAG pipeline's draft workflow.",
    needs: "console",
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), inputs: O("run inputs") }, required: ["pipeline_id", "inputs"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).runRagDraft(req(a, "pipeline_id"), obj(a, "inputs")),
  },
  {
    name: "rag.run_published",
    summary: "Run a RAG pipeline's published workflow.",
    needs: "console",
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), inputs: O("run inputs") }, required: ["pipeline_id", "inputs"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).runRagPublished(req(a, "pipeline_id"), obj(a, "inputs")),
  },
  {
    name: "rag.run_node",
    summary: "Run a single draft node in a RAG pipeline for debugging.",
    needs: "console",
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), node_id: S("node id"), inputs: O("input variables") }, required: ["pipeline_id", "node_id", "inputs"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).runRagNode(req(a, "pipeline_id"), req(a, "node_id"), obj(a, "inputs")),
  },
  {
    name: "rag.stop",
    summary: "Stop a running RAG pipeline task.",
    needs: "console",
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), task_id: S("task id") }, required: ["pipeline_id", "task_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).stopRagTask(req(a, "pipeline_id"), req(a, "task_id")),
  },
  {
    name: "rag.publish",
    summary: "Publish a RAG pipeline's draft. confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), body: O("publish body (marked_name, etc.)"), confirm: CONFIRM }, required: ["pipeline_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).publishRag(req(a, "pipeline_id"), a.body && typeof a.body === "object" ? a.body as Record<string, unknown> : {}),
  },
  {
    name: "rag.list_versions",
    summary: "List published RAG pipeline workflow versions.",
    needs: "console",
    schema: { type: "object", properties: { pipeline_id: S("pipeline id") }, required: ["pipeline_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listRagVersions(req(a, "pipeline_id")),
  },
  {
    name: "rag.get_version",
    summary: "Get one published RAG pipeline workflow version.",
    needs: "console",
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), workflow_id: S("workflow version id") }, required: ["pipeline_id", "workflow_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).getRagVersion(req(a, "pipeline_id"), req(a, "workflow_id")),
  },
  {
    name: "rag.update_version",
    summary: "Update (PATCH) a published RAG pipeline workflow version's metadata.",
    needs: "console",
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), workflow_id: S("workflow version id"), body: O("update body") }, required: ["pipeline_id", "workflow_id", "body"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).updateRagVersion(req(a, "pipeline_id"), req(a, "workflow_id"), obj(a, "body")),
  },
  {
    name: "rag.restore",
    summary: "Restore a published RAG pipeline version as draft. confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), workflow_id: S("workflow version id"), confirm: CONFIRM }, required: ["pipeline_id", "workflow_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).restoreRagVersion(req(a, "pipeline_id"), req(a, "workflow_id")),
  },
  {
    name: "rag.delete_version",
    summary: "Delete a published RAG pipeline version. confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { pipeline_id: S("pipeline id"), workflow_id: S("workflow version id"), confirm: CONFIRM }, required: ["pipeline_id", "workflow_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).deleteRagVersion(req(a, "pipeline_id"), req(a, "workflow_id")),
  },
  // ============ P3: customized snippets (lifecycle + workflow) ============
  {
    name: "snippet.list",
    summary: "List customized snippets in the workspace.",
    needs: "console",
    schema: { type: "object", properties: { page: { type: "number" }, limit: { type: "number" }, keyword: S("search keyword") } },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listSnippets({ page: num(a.page), limit: num(a.limit), keyword: str(a.keyword) }),
  },
  {
    name: "snippet.create",
    summary: "Create a customized snippet (type: node|workflow).",
    needs: "console",
    schema: { type: "object", properties: { body: O("payload: {type, name, description?, icon_info?, input_fields?}") }, required: ["body"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).createSnippet(obj(a, "body")),
  },
  {
    name: "snippet.get",
    summary: "Describe one customized snippet.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id") }, required: ["snippet_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).getSnippet(req(a, "snippet_id")),
  },
  {
    name: "snippet.update",
    summary: "Update a customized snippet (PATCH).",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id"), body: O("update body") }, required: ["snippet_id", "body"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).updateSnippet(req(a, "snippet_id"), obj(a, "body")),
  },
  {
    name: "snippet.delete",
    summary: "Delete a customized snippet. confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { snippet_id: S("snippet id"), confirm: CONFIRM }, required: ["snippet_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).deleteSnippet(req(a, "snippet_id")),
  },
  {
    name: "snippet.export",
    summary: "Export a customized snippet as DSL.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id") }, required: ["snippet_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).exportSnippet(req(a, "snippet_id")),
  },
  {
    name: "snippet.import",
    summary: "Import a customized snippet from DSL (2-step confirm flow). confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { yaml: S("DSL YAML content"), yaml_url: S("...or YAML URL"), name: S("override name"), confirm: CONFIRM }, required: ["confirm"] },
    run: async (a, ctx) => {
      const c = needClient(ctx, "console") as ConsoleClient;
      const body: Record<string, unknown> = {};
      if (str(a.yaml)) { body.mode = "yaml-content"; body.yaml_content = str(a.yaml); }
      else if (str(a.yaml_url)) { body.mode = "yaml-url"; body.yaml_url = str(a.yaml_url); }
      else throw new ToolError("USAGE_ERROR", "pass yaml (content) or yaml_url");
      if (str(a.name)) body.name = str(a.name);
      const imp = await c.importSnippet(body);
      if (!imp.ok) return imp;
      const data = (imp.data ?? {}) as Record<string, unknown>;
      const importId = str(data.import_id) ?? str(data.id);
      const pending = data.status === "pending" || data.result === "pending" || (importId && data.result === undefined);
      if (importId && pending) {
        const conf = await c.confirmSnippetImport(importId);
        return conf.ok ? ok({ imported: true, confirmed: true, ...((conf.data as Record<string, unknown>) ?? {}) }) : conf;
      }
      return ok({ imported: true, confirmed: false, ...data });
    },
  },
  {
    name: "snippet.import_confirm",
    summary: "Confirm a snippet import explicitly by import_id.",
    needs: "console",
    schema: { type: "object", properties: { import_id: S("import id") }, required: ["import_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).confirmSnippetImport(req(a, "import_id")),
  },
  {
    name: "snippet.check_deps",
    summary: "Check plugin dependencies for a snippet.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id") }, required: ["snippet_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).checkSnippetDeps(req(a, "snippet_id")),
  },
  {
    name: "snippet.get_draft",
    summary: "Get a snippet's draft workflow graph, features, hash.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id") }, required: ["snippet_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).getSnippetDraft(req(a, "snippet_id")),
  },
  {
    name: "snippet.sync_draft",
    summary: "Save a snippet's draft graph. Pass graph, features, hash.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id"), graph: O("{nodes, edges}"), features: O("features"), hash: S("current draft hash") }, required: ["snippet_id", "graph"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).syncSnippetDraft(req(a, "snippet_id"), pick(a, ["graph", "features", "hash"])),
  },
  {
    name: "snippet.node_defaults",
    summary: "Get default node config schema for a snippet workflow.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id") }, required: ["snippet_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).snippetNodeDefaults(req(a, "snippet_id")),
  },
  {
    name: "snippet.publish",
    summary: "Publish a snippet's draft workflow. confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { snippet_id: S("snippet id"), body: O("publish body"), confirm: CONFIRM }, required: ["snippet_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).publishSnippet(req(a, "snippet_id"), a.body && typeof a.body === "object" ? a.body as Record<string, unknown> : {}),
  },
  {
    name: "snippet.list_versions",
    summary: "List published snippet workflow versions.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id") }, required: ["snippet_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listSnippetVersions(req(a, "snippet_id")),
  },
  {
    name: "snippet.restore",
    summary: "Restore a published snippet version as draft. confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { snippet_id: S("snippet id"), workflow_id: S("workflow version id"), confirm: CONFIRM }, required: ["snippet_id", "workflow_id", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).restoreSnippetVersion(req(a, "snippet_id"), req(a, "workflow_id")),
  },
  {
    name: "snippet.update_version",
    summary: "Update (PATCH) a published snippet workflow version's metadata.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id"), workflow_id: S("workflow version id"), body: O("update body") }, required: ["snippet_id", "workflow_id", "body"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).updateSnippetVersion(req(a, "snippet_id"), req(a, "workflow_id"), obj(a, "body")),
  },
  {
    name: "snippet.run_draft",
    summary: "Run a snippet's draft workflow with inputs.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id"), inputs: O("run inputs") }, required: ["snippet_id", "inputs"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).runSnippetDraft(req(a, "snippet_id"), obj(a, "inputs")),
  },
  {
    name: "snippet.run_node",
    summary: "Run a single draft node in a snippet workflow for debugging.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id"), node_id: S("node id"), inputs: O("input variables") }, required: ["snippet_id", "node_id", "inputs"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).runSnippetNode(req(a, "snippet_id"), req(a, "node_id"), obj(a, "inputs")),
  },
  {
    name: "snippet.stop",
    summary: "Stop a running snippet workflow task.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id"), task_id: S("task id") }, required: ["snippet_id", "task_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).stopSnippetTask(req(a, "snippet_id"), req(a, "task_id")),
  },
  {
    name: "snippet.list_runs",
    summary: "List snippet workflow runs.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id"), page: { type: "number" }, limit: { type: "number" } }, required: ["snippet_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).listSnippetRuns(req(a, "snippet_id"), { page: num(a.page), limit: num(a.limit) }),
  },
  {
    name: "snippet.get_run",
    summary: "Get one snippet workflow run.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id"), run_id: S("run id") }, required: ["snippet_id", "run_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).getSnippetRun(req(a, "snippet_id"), req(a, "run_id")),
  },
  {
    name: "snippet.run_node_executions",
    summary: "Get node executions for a snippet workflow run.",
    needs: "console",
    schema: { type: "object", properties: { snippet_id: S("snippet id"), run_id: S("run id") }, required: ["snippet_id", "run_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).snippetRunNodeExecutions(req(a, "snippet_id"), req(a, "run_id")),
  },
  // ============ P3: agent config / drive / sandbox ============
  {
    name: "agent.config_manifest",
    summary: "Get the agent config manifest for an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentConfigManifest(req(a, "app_id")),
  },
  {
    name: "agent.config_skills",
    summary: "List agent config skills for an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentConfigSkills(req(a, "app_id")),
  },
  {
    name: "agent.config_skill_upload",
    summary: "Upload a skill to an app's agent config (multipart). confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), file: O("skill file payload"), confirm: CONFIRM }, required: ["app_id", "file", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentConfigSkillUpload(req(a, "app_id"), obj(a, "file")),
  },
  {
    name: "agent.config_skill_inspect",
    summary: "Inspect one agent config skill by name.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), name: S("skill name") }, required: ["app_id", "name"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentConfigSkillInspect(req(a, "app_id"), req(a, "name")),
  },
  {
    name: "agent.config_skill_preview",
    summary: "Preview a skill file for an app's agent config.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), name: S("skill name") }, required: ["app_id", "name"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentConfigSkillPreview(req(a, "app_id"), req(a, "name")),
  },
  {
    name: "agent.config_files",
    summary: "List agent config files for an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentConfigFiles(req(a, "app_id")),
  },
  {
    name: "agent.config_file_upload",
    summary: "Upload a file to an app's agent config (multipart). confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { app_id: S("app uuid"), file: O("file payload"), confirm: CONFIRM }, required: ["app_id", "file", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentConfigFileUpload(req(a, "app_id"), obj(a, "file")),
  },
  {
    name: "agent.drive_files",
    summary: "List agent drive files for an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentDriveFiles(req(a, "app_id")),
  },
  {
    name: "agent.drive_skills",
    summary: "List agent drive skills for an app.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid") }, required: ["app_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentDriveSkills(req(a, "app_id")),
  },
  {
    name: "agent.drive_skill_inspect",
    summary: "Inspect one agent drive skill by path.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), skill_path: S("skill path") }, required: ["app_id", "skill_path"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentDriveSkillInspect(req(a, "app_id"), req(a, "skill_path")),
  },
  {
    name: "agent.drive_preview",
    summary: "Preview a drive file (truncated text). Params: {key, node_id?}.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), params: O("query: {key, node_id?}") }, required: ["app_id", "params"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentDrivePreview(req(a, "app_id"), obj(a, "params")),
  },
  {
    name: "agent.drive_download",
    summary: "Get a signed download URL for a drive file. Params: {key, node_id?}.",
    needs: "console",
    schema: { type: "object", properties: { app_id: S("app uuid"), params: O("query: {key, node_id?}") }, required: ["app_id", "params"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentDriveDownload(req(a, "app_id"), obj(a, "params")),
  },
  {
    name: "agent.sandbox_info",
    summary: "Get sandbox info for an agent.",
    needs: "console",
    schema: { type: "object", properties: { agent_id: S("agent id") }, required: ["agent_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentSandboxInfo(req(a, "agent_id")),
  },
  {
    name: "agent.sandbox_files",
    summary: "List files in an agent's sandbox.",
    needs: "console",
    schema: { type: "object", properties: { agent_id: S("agent id") }, required: ["agent_id"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentSandboxFiles(req(a, "agent_id")),
  },
  {
    name: "agent.sandbox_read",
    summary: "Read a file in an agent's sandbox. Params: {conversation_id, path}.",
    needs: "console",
    schema: { type: "object", properties: { agent_id: S("agent id"), params: O("query: {conversation_id, path}") }, required: ["agent_id", "params"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentSandboxRead(req(a, "agent_id"), obj(a, "params")),
  },
  {
    name: "agent.sandbox_upload",
    summary: "Upload a file to an agent's sandbox (multipart). confirm=true required.",
    needs: "console",
    confirm: true,
    schema: { type: "object", properties: { agent_id: S("agent id"), file: O("file payload"), confirm: CONFIRM }, required: ["agent_id", "file", "confirm"] },
    run: async (a, ctx) => (needClient(ctx, "console") as ConsoleClient).agentSandboxUpload(req(a, "agent_id"), obj(a, "file")),
  },

];

export async function runTool(tool: Tool, args: Record<string, unknown>, flags: Flags): Promise<Result<unknown>> {
  let result: Result<unknown>;
  if (tool.confirm && args.confirm !== true) {
    result = err("CONFIRM_REQUIRED", `'${tool.name}' is destructive; pass confirm=true (CLI: --yes) to proceed`);
  } else {
    try {
      result = await tool.run(args, makeCtx(flags));
    } catch (e) {
      if (e instanceof ToolError) {
        result = err(e.code, e.message, { retryable: e.retryable, details: e.details });
      } else {
        throw e;
      }
    }
  }
  audit(String(flags._surface ?? "cli"), tool.name, args, result);
  return result;
}

function audit(surface: string, tool: string, args: Record<string, unknown>, result: Result<unknown>): void {
  try {
    const dir = path.join(os.homedir(), ".difywf");
    fs.mkdirSync(dir, { recursive: true });
    const entry = { ts: new Date().toISOString(), surface, tool, ok: result.ok, code: result.ok ? null : result.error.code, args: redact(args) };
    fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(entry) + "\n");
  } catch {
    // never break a tool call because audit logging failed
  }
}

function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = /token|secret|credential|password|api[-_]?key/i.test(k) ? "[redacted]" : v;
  }
  return out;
}

function graphDiff(a: Graph, b: Graph): unknown {
  const an = new Map(a.nodes.map((n) => [n.id, n]));
  const bn = new Map(b.nodes.map((n) => [n.id, n]));
  const edgeKey = (e: GraphEdge) => `${e.source}->${e.target}:${e.sourceHandle ?? ""}`;
  const ae = new Set(a.edges.map(edgeKey));
  const be = new Set(b.edges.map(edgeKey));
  return {
    nodes: {
      added: [...bn.keys()].filter((id) => !an.has(id)),
      removed: [...an.keys()].filter((id) => !bn.has(id)),
      changed: [...bn.keys()].filter((id) => an.has(id) && JSON.stringify(an.get(id)) !== JSON.stringify(bn.get(id))),
    },
    edges: { added: [...be].filter((x) => !ae.has(x)), removed: [...ae].filter((x) => !be.has(x)) },
  };
}

function parseGraphArg(args: Record<string, unknown>): Graph {
  if (args.graph && typeof args.graph === "object") return args.graph as Graph;
  if (typeof args.graph_json === "string") {
    try {
      return JSON.parse(args.graph_json) as Graph;
    } catch {
      throw new ToolError("USAGE_ERROR", "graph_json is not valid JSON");
    }
  }
  throw new ToolError("USAGE_ERROR", "pass graph (object) or graph_json (string)");
}

function defaultsToMap(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    const map: Record<string, unknown> = {};
    for (const item of data) {
      if (item && typeof item === "object") {
        const t = (item as Record<string, unknown>).type;
        if (typeof t === "string") map[t] = item;
      }
    }
    return map;
  }
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && v && !Number.isNaN(Number(v)) ? Number(v) : undefined);
const req = (args: Record<string, unknown>, key: string): string => {
  const v = str(args[key]);
  if (!v) throw new ToolError("USAGE_ERROR", `missing required argument '${key}'`);
  return v;
};
const obj = (args: Record<string, unknown>, key: string): Record<string, unknown> => {
  const v = args[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ToolError("USAGE_ERROR", `argument '${key}' must be an object`);
  return v as Record<string, unknown>;
};
const pick = (args: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
};
