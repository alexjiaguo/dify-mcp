// CLI surface: `difywf <ns> <verb> [flags]`. Parses args, resolves config,
// calls the shared registry, prints the contract, sets the exit code.

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { EXIT, err, toYaml, type Result } from "./core/contract.ts";
import { resolveConfig, maskToken } from "./core/config.ts";
import { consoleLogin, deviceLoginFlow, parseAuthCookiesFromInput, storeCookies, storeToken } from "./core/auth.ts";
import { runTool, tools } from "./tools/registry.ts";

const VERSION = "0.2.0";

const NS_ALIASES: Record<string, string> = {
  wf: "workflow",
  providers: "provider",
  plugins: "plugin",
};
const CMD_ALIASES: Record<string, string> = {
  "workflow test": "workflow.run_draft",
  "workflow draft get": "workflow.get_draft",
  "workflow draft sync": "workflow.sync_draft",
  "workflow node defaults": "workflow.node_defaults",
  "workflow node run": "workflow.run_node",
};
const POSITIONALS: Record<string, string[]> = {
  "app.get": ["app_id"], "app.update": ["app_id"], "app.list_tags": ["app_id"], "app.ensure_tag": ["app_id", "tag"], "app.remove_tag": ["app_id", "tag"], "app.delete": ["app_id"], "app.export": ["app_id"],
  "workflow.get_draft": ["app_id"], "workflow.node_defaults": ["app_id", "node_type"], "workflow.sync_draft": ["app_id"],
  "workflow.run_draft": ["app_id"], "workflow.run": ["app_id"], "workflow.publish": ["app_id"],
  "workflow.run_node": ["app_id", "node_id"], "workflow.node_last_run": ["app_id", "node_id"], "workflow.events": ["app_id", "task_id"], "workflow.stop": ["app_id", "task_id"],
  "workflow.tool_get": ["app_id"], "workflow.tool_refresh_provider": ["app_id"], "workflow.tool_delete": ["workflow_tool_id"],
  "provider.models": ["provider"],
  "plugin.get": ["plugin_unique_identifier"], "plugin.uninstall": ["plugin_installation_id"],
  "workflow.get_features": ["app_id"], "workflow.set_features": ["app_id"],
  "workflow.list_env_vars": ["app_id"], "workflow.list_conv_vars": ["app_id"],
  "workflow.create_variable": ["app_id"], "workflow.update_variable": ["app_id", "variable_id"], "workflow.delete_variable": ["app_id", "variable_id"],
  "workflow.list_versions": ["app_id"], "workflow.get_version": ["app_id", "workflow_id"], "workflow.restore": ["app_id", "workflow_id"], "workflow.delete_version": ["app_id", "workflow_id"],
  "app.copy": ["app_id"], "app.rename": ["app_id"], "app.set_icon": ["app_id"], "app.convert": ["app_id"], "app.check_deps": ["app_id"],
  "app.chat": ["app_id"], "app.complete": ["app_id"],
  "trigger.list": ["app_id"], "trigger.create": ["app_id"], "trigger.enable": ["app_id"], "trigger.webhook": ["app_id"],
  "workflow.trigger_run": ["app_id"], "workflow.trigger_run_all": ["app_id"],
  "workspace.get": ["workspace_id"], "workspace.switch": ["workspace_id"], "workspace.members": ["workspace_id"],
  "file.upload": ["app_id"],
  "workflow.hitl_preview": ["app_id", "node_id"], "workflow.hitl_submit": ["app_id", "node_id"],
  "runs.list": ["app_id"], "runs.get": ["app_id", "run_id"], "runs.node_executions": ["app_id", "run_id"], "runs.export": ["app_id", "run_id"],
  "stats.daily_conversations": ["app_id"], "stats.daily_terminals": ["app_id"], "stats.token_costs": ["app_id"], "stats.average_app_interactions": ["app_id"],
  "comment.list": ["app_id"], "comment.add": ["app_id"], "comment.resolve": ["app_id", "comment_id"],
  "annotation.list": ["app_id"], "annotation.add": ["app_id"], "annotation.delete": ["app_id", "annotation_id"],
  "audio.transcribe": ["app_id"], "audio.synthesize": ["app_id"], "audio.voices": ["app_id", "language"],
  "explore.run": ["installed_app_id"], "explore.stop": ["installed_app_id", "task_id"],
  "annotation.reply_action": ["app_id", "action"], "annotation.reply_status": ["app_id", "action", "job_id"],
  "annotation.get_settings": ["app_id"], "annotation.update_settings": ["app_id", "setting_id"],
  "annotation.export": ["app_id"], "annotation.batch_import": ["app_id"], "annotation.import_status": ["app_id", "job_id"], "annotation.hit_histories": ["app_id", "annotation_id"],
  "rag.get_template": ["template_id"], "rag.get_draft": ["pipeline_id"], "rag.sync_draft": ["pipeline_id"], "rag.node_defaults": ["pipeline_id", "block_type"],
  "rag.run_draft": ["pipeline_id"], "rag.run_published": ["pipeline_id"], "rag.run_node": ["pipeline_id", "node_id"], "rag.stop": ["pipeline_id", "task_id"],
  "rag.publish": ["pipeline_id"], "rag.list_versions": ["pipeline_id"], "rag.get_version": ["pipeline_id", "workflow_id"],
  "rag.update_version": ["pipeline_id", "workflow_id"], "rag.restore": ["pipeline_id", "workflow_id"], "rag.delete_version": ["pipeline_id", "workflow_id"],
  "snippet.get": ["snippet_id"], "snippet.update": ["snippet_id"], "snippet.delete": ["snippet_id"], "snippet.export": ["snippet_id"],
  "snippet.import_confirm": ["import_id"], "snippet.check_deps": ["snippet_id"],
  "snippet.get_draft": ["snippet_id"], "snippet.sync_draft": ["snippet_id"], "snippet.node_defaults": ["snippet_id"], "snippet.publish": ["snippet_id"],
  "snippet.list_versions": ["snippet_id"], "snippet.restore": ["snippet_id", "workflow_id"], "snippet.update_version": ["snippet_id", "workflow_id"],
  "snippet.run_draft": ["snippet_id"], "snippet.run_node": ["snippet_id", "node_id"], "snippet.stop": ["snippet_id", "task_id"],
  "snippet.list_runs": ["snippet_id"], "snippet.get_run": ["snippet_id", "run_id"], "snippet.run_node_executions": ["snippet_id", "run_id"],
  "agent.config_manifest": ["app_id"], "agent.config_skills": ["app_id"], "agent.config_skill_upload": ["app_id"],
  "agent.config_skill_inspect": ["app_id", "name"], "agent.config_skill_preview": ["app_id", "name"],
  "agent.config_files": ["app_id"], "agent.config_file_upload": ["app_id"],
  "agent.drive_files": ["app_id"], "agent.drive_skills": ["app_id"], "agent.drive_skill_inspect": ["app_id", "skill_path"],
  "agent.drive_preview": ["app_id"], "agent.drive_download": ["app_id"],
  "agent.sandbox_info": ["agent_id"], "agent.sandbox_files": ["agent_id"], "agent.sandbox_read": ["agent_id"], "agent.sandbox_upload": ["agent_id"],
  "agent.guide": ["section"],
};
const CONTROL_FLAGS = new Set([
  "o", "output", "output-file", "help", "h", "version", "base-url", "workspace",
  "openapi-token", "console-token", "console-cookie",
]);

export function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, unknown> } {
  const positional: string[] = [];
  const flags: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-") && !a.startsWith("--") && a.length === 2) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq > 2 ? a.slice(2, eq) : a.slice(2);
    let value: unknown = true;
    if (eq > 2) {
      value = a.slice(eq + 1);
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      value = argv[++i];
    }
    if (flags[key] !== undefined) {
      flags[key] = Array.isArray(flags[key]) ? [...(flags[key] as unknown[]), value] : [flags[key], value];
    } else {
      flags[key] = value;
    }
  }
  return { positional, flags };
}

export function resolveConsoleLoginCredentials(
  flags: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { email?: string; password?: string; passwordEncoding: "plain" | "base64" } {
  const rawEncoding = str(flags["password-encoding"])
    ?? str(env.DIFY_CONSOLE_PASSWORD_ENCODING)
    ?? "plain";
  if (rawEncoding !== "plain" && rawEncoding !== "base64") {
    throw new Error("password encoding must be 'plain' or 'base64'");
  }
  return {
    email: str(flags.email) ?? str(env.DIFY_CONSOLE_EMAIL),
    password: str(flags.password) ?? str(env.DIFY_CONSOLE_PASSWORD),
    passwordEncoding: rawEncoding,
  };
}

export async function main(): Promise<void> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  if (flags.version === true || positional[0] === "version") return printRaw(VERSION);
  if (flags.help === true || flags.h === true || positional.length === 0) return printHelp(positional);

  if (positional[0] === "auth") return authMain(positional.slice(1), flags);
  if (positional[0] === "mcp") {
    const sub = positional[1];
    if (sub !== undefined && sub !== "serve") {
      return finish(err("USAGE_ERROR", `unknown mcp subcommand '${sub}'. Use: difywf mcp serve [--http]`), flags);
    }
    await import("./mcp.ts");
    return;
  }

  const ns = NS_ALIASES[positional[0]] ?? positional[0];
  const rest = positional.slice(1);
  let toolName: string | undefined;
  let consumed = 0;
  for (let n = rest.length; n >= 1; n--) {
    const phrase = [ns, ...rest.slice(0, n)].join(" ");
    const dotted = `${ns}.${rest.slice(0, n).join("_").replaceAll("-", "_")}`;
    if (CMD_ALIASES[phrase]) { toolName = CMD_ALIASES[phrase]; consumed = n; break; }
    if (tools.some((t) => t.name === dotted)) { toolName = dotted; consumed = n; break; }
  }
  const tool = toolName ? tools.find((t) => t.name === toolName) : undefined;
  if (!tool || !toolName) {
    return finish(
      err("USAGE_ERROR", `unknown command '${positional.join(" ")}'. Run \`difywf --help\` for the command list.`),
      flags,
    );
  }
  const posKeys = POSITIONALS[toolName] ?? [];
  const trailing = rest.slice(consumed);
  if (trailing.length > posKeys.length) {
    return finish(err("USAGE_ERROR", `too many positional arguments for '${toolName}' (expected ${posKeys.length})`), flags);
  }

  let args: Record<string, unknown>;
  try {
    args = buildArgs(flags);
    for (let i = 0; i < trailing.length; i++) args[posKeys[i]] = trailing[i];
  } catch (e) {
    return finish(err("USAGE_ERROR", e instanceof Error ? e.message : String(e)), flags);
  }
  const result = await runTool(tool, args, { ...flags, _surface: "cli" });
  return finish(result, flags);
}

function buildArgs(flags: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (CONTROL_FLAGS.has(k)) continue;
    if (k === "yes") args.confirm = true;
    else if (k === "dry-run") args.dry_run = true;
    else if (k === "input") args.inputs = kvList(v, "input");
    else if (k === "graph") args.graph = readJsonArg(v, "graph");
    else if (k === "graph-json") args.graph_json = String(v);
    else if (k === "yaml") args.yaml = readTextArg(v, "yaml");
    else if (k === "credentials") args.credentials = readJsonArg(v, "credentials");
    else if (k === "app-id") args.app_id = v;
    else if (k === "node-id") args.node_id = v;
    else if (k === "task-id") args.task_id = v;
    else if (k === "node-type") args.node_type = v;
    else if (k === "page" || k === "limit") args[k] = Number(v);
    else args[k.replaceAll("-", "_")] = typeof v === "string" && (v.startsWith("{") || v.startsWith("[")) ? readJsonArg(v, k) : v;
  }
  return args;
}

// Large DSLs exceed the operating system's per-argument limit. Keep literal
// YAML backward compatible while allowing the same explicit @file/stdin
// channel already used by --graph.
export function readTextArg(value: unknown, name: string): string {
  const s = String(value);
  if (s === "-") return fs.readFileSync(0, "utf8");
  if (!s.startsWith("@")) return s;
  const p = s.slice(1);
  if (!fs.existsSync(p)) throw new Error(`--${name}: file not found: ${p}`);
  return fs.readFileSync(p, "utf8");
}

// --graph/--credentials accept: "-" (stdin), "@file"/path, or an inline JSON string.
function readJsonArg(value: unknown, name: string): unknown {
  const s = String(value);
  let text: string;
  if (s === "-") {
    text = fs.readFileSync(0, "utf8");
  } else if (s.startsWith("{") || s.startsWith("[")) {
    text = s;
  } else {
    const p = s.startsWith("@") ? s.slice(1) : s;
    if (!fs.existsSync(p)) throw new Error(`--${name}: file not found: ${p}`);
    text = fs.readFileSync(p, "utf8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`--${name}: not valid JSON`);
  }
}

function kvList(v: unknown, name: string): Record<string, unknown> {
  const items = Array.isArray(v) ? v : [v];
  const out: Record<string, unknown> = {};
  for (const item of items) {
    const s = String(item);
    const eq = s.indexOf("=");
    if (eq <= 0) throw new Error(`--${name} expects key=value, got '${s}'`);
    out[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return out;
}

async function authMain(args: string[], flags: Record<string, unknown>): Promise<void> {
  const sub = args[0] ?? "status";
  const cfg = resolveConfig(flags);
  const needBase = (): string => {
    if (!cfg.baseUrl) {
      finish(err("USAGE_ERROR", "no base URL; pass --base-url or set DIFY_API_BASE"), flags);
      process.exit(EXIT.USAGE_ERROR);
    }
    return cfg.baseUrl;
  };
  switch (sub) {
    case "status":
      return finish(
        { ok: true, data: { base_url: cfg.baseUrl || null, workspace: cfg.workspaceId ?? null, openapi_token: maskToken(cfg.openapiToken), console_token: maskToken(cfg.consoleToken), console_cookies: cfg.consoleCookies ? Object.keys(cfg.consoleCookies) : null } },
        flags,
      );
    case "login": {
      const base = needBase();
      const result = await deviceLoginFlow(base, str(flags.label), (info) => {
        process.stderr.write(`\nOpen this URL and enter the code:\n  ${info.verification_uri_complete ?? info.verification_uri ?? "(url unknown)"}\n  code: ${info.user_code ?? "(see browser)"}\n\nwaiting for approval...\n`);
      });
      if (result.ok) {
        const token = typeof result.data.access_token === "string" ? result.data.access_token : null;
        if (token) storeToken(base, "openapi_token", token);
      }
      return finish(result.ok ? { ok: true, data: { stored: true, base_url: base } } : (result as Result<unknown>), flags);
    }
    case "login-console": {
      const base = needBase();
      let credentials: ReturnType<typeof resolveConsoleLoginCredentials>;
      try {
        credentials = resolveConsoleLoginCredentials(flags);
      } catch (e) {
        return finish(err("USAGE_ERROR", e instanceof Error ? e.message : String(e)), flags);
      }
      const { email, password, passwordEncoding } = credentials;
      if (!email || !password) {
        return finish(
          err(
            "USAGE_ERROR",
            "login-console needs --email/--password or DIFY_CONSOLE_EMAIL/DIFY_CONSOLE_PASSWORD",
          ),
          flags,
        );
      }
      const result = await consoleLogin(base, email, password, passwordEncoding);
      if (result.ok) storeCookies(base, result.data);
      return finish(result.ok ? { ok: true, data: { stored: true, base_url: base, cookies: Object.keys(result.data) } } : (result as Result<unknown>), flags);
    }
    case "token": {
      const base = needBase();
      if (str(flags["openapi-token"])) storeToken(base, "openapi_token", str(flags["openapi-token"])!);
      if (str(flags["console-token"])) storeToken(base, "console_token", str(flags["console-token"])!);
      if (str(flags["console-cookie"])) {
        const c = parseAuthCookiesFromInput(str(flags["console-cookie"])!);
        if (Object.keys(c).length) storeCookies(base, c);
      }
      return finish({ ok: true, data: { stored: true, base_url: base } }, flags);
    }
    case "import-cookies":
    case "import": {
      const base = needBase();
      let text: string;
      const file = str(flags.file);
      if (file) text = fs.readFileSync(file, "utf8");
      else if (str(flags.json)) text = str(flags.json)!;
      else text = fs.readFileSync(0, "utf8"); // stdin
      const cookies = parseAuthCookiesFromInput(text);
      if (!Object.keys(cookies).length) {
        return finish(err("USAGE_ERROR", "no auth cookies found in input; expected a browser cookie-export JSON or a Cookie header containing access_token/console_token, csrf_token, refresh_token"), flags);
      }
      storeCookies(base, cookies);
      return finish({ ok: true, data: { stored: true, base_url: base, cookies: Object.keys(cookies) } }, flags);
    }
    default:
      return finish(err("USAGE_ERROR", `unknown auth subcommand '${sub}'. Use: login | login-console | token | import-cookies | status`), flags);
  }
}

function finish(result: Result<unknown>, flags: Record<string, unknown>): void {
  const format = String(flags.o ?? flags.output ?? "json");
  const outputFile = str(flags["output-file"]);
  if (outputFile) {
    const rendered = format === "yaml" ? toYaml(result) + "\n" : JSON.stringify(result) + "\n";
    fs.writeFileSync(outputFile, rendered, { encoding: "utf8" });
    process.stdout.write(JSON.stringify({
      ok: result.ok,
      output_file: outputFile,
      ...(result.ok ? {} : { error: result.error }),
    }) + "\n");
    process.exit(result.ok ? EXIT.OK : EXIT[result.error.code]);
  }
  if (format === "yaml") {
    process.stdout.write(toYaml(result) + "\n");
  } else if (format === "text") {
    if (result.ok) {
      process.stdout.write((typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2)) + "\n");
    } else {
      process.stderr.write(`ERROR ${result.error.code}: ${result.error.message}\n`);
    }
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
  process.exit(result.ok ? EXIT.OK : EXIT[result.error.code]);
}

function printRaw(s: string): void {
  process.stdout.write(s + "\n");
  process.exit(0);
}

function printHelp(positional: string[]): void {
  const lines = [
    `difywf ${VERSION} — agent-agnostic Dify workflow authoring (CLI + MCP)`,
    "",
    "USAGE",
    "  difywf <namespace> <verb> [flags]     e.g. difywf wf draft sync --graph graph.json --dry-run",
    "  difywf auth <login|login-console|token|import-cookies|status>",
    "  difywf mcp serve                       start the MCP server (stdio; add --http for Streamable HTTP)",
    "",
    "COMMANDS",
    ...tools.map((t) => `  ${t.name.padEnd(28)} ${t.summary}`),
    "",
    "GLOBAL FLAGS",
    "  -o, --output json|yaml|text   output format (default json; MCP always json)",
    "  --output-file <path>          write the full result to a file; stdout returns a small acknowledgement",
    "  --base-url <url>              Dify base URL (or DIFY_API_BASE)",
    "  --workspace <id>              workspace id (or DIFY_WORKSPACE_ID)",
    "  --openapi-token / --console-token   tokens (or DIFY_OPENAPI_TOKEN / DIFY_CONSOLE_TOKEN)",
    "  --console-cookie <header|json>     console session cookies (or DIFY_CONSOLE_COOKIE)",
    "  --email / --password            console login (or DIFY_CONSOLE_EMAIL / DIFY_CONSOLE_PASSWORD)",
    "  --password-encoding <plain|base64>  login payload encoding (or DIFY_CONSOLE_PASSWORD_ENCODING)",
    "  --yes                         confirm destructive ops (maps to confirm=true)",
    "  --dry-run                     validate + diff without saving",
    "  --graph <file|-|{json}>       graph input: file, stdin, or inline JSON",
    "  --yaml <@file|-|yaml>         app-import DSL: explicit file, stdin, or inline YAML",
    "  --input k=v                   workflow input (repeatable)",
    "",
    "Start with: difywf agent guide",
  ];
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(EXIT.SERVER_ERROR);
  });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
