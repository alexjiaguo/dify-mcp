<div align="center">

# dify-mcp

### The most complete MCP server + CLI for [Dify](https://github.com/langgenius/dify)

**153 tools. 18 namespaces. One registry.** Let any AI agent build, test, and ship
Dify workflows autonomously — everything a human can do in the UI, now scriptable.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/alexjiaguo/dify-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/alexjiaguo/dify-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/alexjiaguo/dify-mcp)](https://github.com/alexjiaguo/dify-mcp/releases/latest)
[![Node >= 23.6](https://img.shields.io/badge/node-%E2%89%A523.6-green.svg)](https://nodejs.org)
[![153 Tools](https://img.shields.io/badge/tools-153-purple.svg)](#tools)
[![Live Verified](https://img.shields.io/badge/live--verified-cloud.dify.ai-brightgreen.svg)](#live-verified)

Works with **Claude Code** · **Codex** · **Gemini CLI** · **Cursor** · **Cline** · **Windsurf** · **Roo Code** · **Continue** · **Aider** · **Zed** — and any other MCP-compatible or shell-capable agent.

</div>

---

## What is this?

Dify is a powerful open-source LLM app platform — but its workflow builder is a
**visual drag-and-drop editor**. What if you want an AI agent to *programmatically*
create workflows, wire up nodes, test them, iterate, and publish — without a browser?

**dify-mcp** is the bridge. It exposes the **entire Dify console API** as a unified
tool registry with **two surfaces**: a CLI any shell-capable agent can drive, and an
MCP server (stdio or Streamable HTTP) any MCP-compatible host can attach. Same 153 tools, same JSON
contract, same safety guarantees.

```
┌──────────────────────────────────────────────────────────┐
│                    dify-mcp                              │
│                                                          │
│   ┌──────────┐    ┌────────────────────┐    ┌─────────┐ │
│   │  CLI     │───▶│   153-tool         │───▶│  Dify   │ │
│   │  difywf  │    │   registry         │    │  API    │ │
│   └──────────┘    │                    │    └─────────┘ │
│   ┌──────────┐    │  app · workflow    │         ▲      │
│   │  MCP     │───▶│  provider · rag    │─────────┘      │
│   │  stdio   │    │  agent · snippet   │                │
│   └──────────┘    │  stats · audio ... │                │
│                   └────────────────────┘                │
└──────────────────────────────────────────────────────────┘
```

## Works with your favorite agents

dify-mcp is agent-agnostic by design — no SDK lock-in, no proprietary protocol. If your
agent can run a shell command, it can use the CLI. If it speaks MCP, it can attach the
server. Most popular agents do both:

| Agent | MCP | CLI | Quick setup |
|-------|:---:|:---:|-------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | ✅ | ✅ | `claude mcp add dify -- difywf mcp serve` |
| [Codex](https://github.com/openai/codex) | ✅ | ✅ | `[mcp_servers.dify]` in `~/.codex/config.toml` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | ✅ | ✅ | `mcpServers.dify` in `~/.gemini/settings.json` |
| [Cursor](https://cursor.com) | ✅ | ✅ | `.cursor/mcp.json` |
| [Cline](https://github.com/cline/cline) | ✅ | ✅ | Same JSON shape as Cursor |
| [Windsurf](https://codeium.com/windsurf) | ✅ | ✅ | MCP server config in Windsurf settings |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | ✅ | ✅ | MCP server config in Roo Code settings |
| [Continue](https://github.com/continuedev/continue) | ✅ | ✅ | `experimental.mcpServer` in `config.json` |
| [Zed](https://zed.dev) | ✅ | ✅ | `context_servers` in `~/.config/zed/settings.json` |
| [Aider](https://github.com/Aider-AI/aider) | - | ✅ | Run `difywf` commands directly in chat |

Don't see your agent? If it supports MCP or can run shell commands, it works. The
[connect section](#connect-your-agent-mcp) below has copy-paste configs for each host.

## Why you'll star this

- **Complete coverage.** Not a subset. Not a wrapper around the public API alone.
  This talks to the **internal console API** — the same surface the Dify web UI uses.
  Create apps, author graphs node-by-node, validate, test-run, publish, manage
  versions, triggers, providers, plugins, RAG pipelines, snippets, agent configs,
  comments, annotations, audio, stats. If the UI can do it, so can your agent.

- **Agent-agnostic by design.** No SDK lock-in. The CLI works with any agent that
  can run a shell command. The MCP server works with any MCP host. Both return
  structured JSON — `{ ok, data }` or `{ ok: false, error: { code, message, retryable } }`
  — so agents never scrape human-readable text. For large drafts and exports, the CLI's
  `--output-file <path>` keeps the full UTF-8 result off size-limited stdout transports.

- **Cookie auth, handled.** Dify's console uses cookie + CSRF double-submit, not
  Bearer tokens. dify-mcp captures, stores (keychain on macOS, else `0600` file),
  and auto-refreshes the session — including server-side refresh-token rotation.
  That same session now covers draft *and* published run/stop, file upload,
  dependency checks, and workspace switch. MCP hosts can call `auth.import_cookies`
  / `auth.login_console` without the CLI. `DIFY_CONSOLE_COOKIE` and
  `--console-cookie` work for non-interactive bootstrap.

- **Safe by default.** Destructive operations require explicit `confirm=true` /
  `--yes`. Graphs are validated offline before sync (iteration/loop sub-graphs,
  sticky notes, and modern multi-case if-else included). Every mutation is
  audit-logged. `--dry-run` shows diffs without saving.

- **Zero build step.** Runs directly on Node 23.6+ native TypeScript. No compiler,
  no bundler, no transpiler. Clone, install, go.

## What's new in [v0.2.0](https://github.com/alexjiaguo/dify-mcp/releases/tag/v0.2.0)

- **Cookie-complete authoring.** Run, stop, upload, check deps, and switch
  workspaces with the same console session. MCP hosts authenticate without dropping
  to the CLI.
- **Safer HTTP MCP.** Binds `127.0.0.1` by default. Binding `0.0.0.0` (Docker)
  requires `DIFYWF_MCP_TOKEN`. Host allowlist + 2MB body cap; `/health` stays open
  for probes.
- **Workflow-as-tool providers.** Get, refresh, or delete the published-tool
  binding after you ship a version (`workflow.tool_get` /
  `workflow.tool_refresh_provider` / `workflow.tool_delete`).
- **Verified app tags.** `app.ensure_tag` / `app.remove_tag` bind or unbind an
  exact tag name and read it back. Confirm-gated.
- **Smarter graph validation.** Iteration/loop inner nodes, canvas `custom-note`
  stickies, and modern `cases[]` if-else branches no longer fail offline checks.
- **Large payloads.** `--yaml @file` for DSLs that exceed OS argument limits;
  `--output-file` keeps big results off size-limited stdout.
- **Starter graphs.** Ready-made templates in [`examples/`](examples/)
  (echo, LLM, RAG). `sync_draft` no longer wipes omitted env/conversation secrets.

## Live verified

Every tool category has been tested against **cloud.dify.ai** with real credentials:

- ✅ Full authoring loop: create app → sync draft → run draft → publish → list versions
- ✅ All 18 namespaces exercised: apps, workflows, providers, plugins, triggers,
  snippets, RAG, agents, stats, comments, annotations, audio, files, runs, workspace,
  archive, explore, auth
- ✅ MCP transport: `tools/call` over stdio and Streamable HTTP with live cookie auth
- ✅ Example templates in `examples/` validate clean (echo, LLM, RAG)
- ✅ Unit tests · typecheck clean · MCP smoke (153 tools)

## Quickstart

**Prerequisites:** Node >= 23.6 (native TypeScript type stripping — no build step).

```bash
git clone https://github.com/alexjiaguo/dify-mcp.git
cd dify-mcp
npm install
npm link        # puts `difywf` on your PATH (optional)
```

### Authenticate

The Dify console uses **cookie + CSRF auth**. The easiest path:

```bash
# 1. Export cookies from your browser (cookie-editor extension → Export → JSON)
# 2. Save as cookies.json, then:
difywf auth import-cookies --base-url https://cloud.dify.ai --file cookies.json

# Or self-hosted with email/password (no browser needed):
difywf auth login-console --base-url https://your-dify --email you@x --password '***'

# Non-interactive bootstrap can keep credentials out of process arguments:
DIFY_CONSOLE_EMAIL=you@x DIFY_CONSOLE_PASSWORD='***' \
  difywf auth login-console --base-url https://your-dify

# Deployments whose login endpoint expects the legacy encoded payload:
DIFY_CONSOLE_EMAIL=you@x DIFY_CONSOLE_PASSWORD='***' \
  DIFY_CONSOLE_PASSWORD_ENCODING=base64 \
  difywf auth login-console --base-url https://your-dify

difywf auth status   # confirm: shows base URL + cookie names (values masked)

# Non-interactive cookie bootstrap (Cookie header or cookie-editor JSON):
# DIFY_CONSOLE_COOKIE='console_token=...; csrf_token=...; refresh_token=...' \
#   difywf auth status --base-url https://cloud.dify.ai
```

### Build a workflow

```bash
difywf agent guide                          # self-onboarding playbook for agents
difywf app list                             # see your apps
difywf app create --mode workflow --name "my-agent-workflow"

difywf wf node defaults <app-id> llm        # get the schema for an LLM node
difywf wf validate --graph examples/llm-workflow.json        # offline: structure, refs, cycles
difywf wf draft sync <app-id> --graph examples/llm-workflow.json --dry-run
difywf wf draft sync <app-id> --graph examples/llm-workflow.json
difywf wf test <app-id> --input query="hello"                # test-run the draft
difywf app import --yaml @workflow.yml --yes                  # file channel for large DSLs
difywf app ensure-tag <app-id> production --yes               # bind + verify exact tag name
difywf wf publish <app-id> --yes                             # ship it
difywf workflow tool refresh-provider <app-id> --yes        # rebind workflow-as-tool to the published version
```

Starter graphs live in [`examples/`](examples/): `minimal-workflow.json` (echo),
`llm-workflow.json` (start → LLM → answer), `rag-workflow.json` (knowledge
retrieval). All three pass `difywf wf validate` with no error-level issues.

### Connect your agent (MCP)

Same binary, same 153 tools. Copy-paste the config for your host:

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add dify -- difywf mcp serve
```
</details>

<details>
<summary><b>Codex</b> (<code>~/.codex/config.toml</code>)</summary>

```toml
[mcp_servers.dify]
command = "difywf"
args = ["mcp", "serve"]
```
</details>

<details>
<summary><b>Cursor</b> (<code>.cursor/mcp.json</code>) · <b>Cline</b> · <b>Roo Code</b> · <b>Continue</b></summary>

```json
{
  "mcpServers": {
    "dify": {
      "command": "difywf",
      "args": ["mcp", "serve"]
    }
  }
}
```
</details>

<details>
<summary><b>Gemini CLI</b> (<code>~/.gemini/settings.json</code>)</summary>

```json
{
  "mcpServers": {
    "dify": {
      "command": "difywf",
      "args": ["mcp", "serve"]
    }
  }
}
```
</details>

<details>
<summary><b>Windsurf</b> (Codeium)</summary>

Add an MCP server in Windsurf settings (`Cmd+,` -> MCP Servers) with command `difywf`
and args `["mcp", "serve"]`.
</details>

<details>
<summary><b>Zed</b> (<code>~/.config/zed/settings.json</code>)</summary>

```json
{
  "context_servers": {
    "dify": {
      "command": "difywf",
      "args": ["mcp", "serve"]
    }
  }
}
```
</details>

<details>
<summary><b>Aider</b> (CLI only — no MCP)</summary>

Aider doesn't support MCP, but it can run shell commands. Just use the CLI directly:

```
/run difywf app list
/run difywf wf draft sync <app-id> --graph graph.json
```
</details>

<details>
<summary><b>Remote host? Streamable HTTP instead of stdio</b></summary>

For remote or containerized hosts that can't spawn a local process, run the MCP
server over the stateless Streamable HTTP transport:

```bash
difywf mcp serve --http --host 127.0.0.1 --port 8080
# or via env: DIFYWF_MCP_TRANSPORT=http DIFYWF_MCP_HOST=127.0.0.1 \
#             DIFYWF_MCP_PORT=8080 difywf mcp serve
```

Loopback binds do not need a token. Binding `0.0.0.0` (including Docker)
requires `DIFYWF_MCP_TOKEN`. Clients send `Authorization: Bearer <token>` or
`x-difywf-token`. `GET /health` stays unauthenticated for probes.

Point any Streamable-HTTP-capable client at `http://<host>:8080/mcp`. Each POST is
a self-contained JSON-RPC message (initialize / tools/list / tools/call); no
session is required. GET and DELETE requests to `/mcp` are rejected with 405.

To run it as a Docker service:

```bash
docker build -t dify-mcp .
docker run -d --name dify-mcp \
  -p 3000:3000 \
  -e DIFY_API_BASE=https://your-dify.example.com \
  -e DIFYWF_MCP_TOKEN=generate-a-long-random-token \
  -e DIFY_CONSOLE_COOKIE='console_token=...; csrf_token=...; refresh_token=...' \
  -v difywf-home:/home/node/.difywf \
  dify-mcp
```

The MCP URL to configure in Dify is `http://<docker-host>:3000/mcp` plus the
Bearer token. When Dify and this service run in the same Docker Compose network,
use the service name, for example `http://dify-mcp:3000/mcp`. The container
health endpoint is `GET /health`. The `difywf` CLI is also available inside the
container, for example `docker exec dify-mcp difywf --version`.

Prefer Docker secrets or your deployment platform's secret store instead of
putting cookies or tokens in the image.
</details>

> No `difywf` on PATH? Use the absolute path: `node /path/to/dify-mcp/bin/difywf.js mcp serve`.

## Tools

**153 tools across 18 namespaces.** Run `difywf --help` for the full live list, or
`difywf agent guide` for the agent-oriented playbook.

| Namespace | Tools | What it does |
|-----------|-------|-------------|
| `app` | 17 | List, create, update, verified tags, delete, export, import (console cookies or OpenAPI; `--yaml @file`), copy, rename, convert, chat, complete |
| `workflow` | 29 | Get/sync drafts, validate (incl. iteration/loop sub-graphs), run, publish, workflow-as-tool providers, node last-run, variables, versions, HITL, features, triggers |
| `provider` | 3 | List providers, list models, set credentials |
| `plugin` | 4 | List, get, install, uninstall plugins |
| `trigger` | 4 | Create, enable, list, webhook triggers; run triggers |
| `workspace` | 4 | List, get, switch workspaces; list members |
| `file` | 1 | Upload files for use in runs (multipart `{name, content_b64}`) |
| `runs` | 4 | List, get, node executions, export run traces |
| `stats` | 5 | Daily conversations/terminals, token costs, app interactions, online users |
| `comment` | 3 | List, add, resolve workflow comments |
| `annotation` | 11 | List, add, delete, reply, settings, export, batch import, hit histories |
| `audio` | 3 | Transcribe (STT), synthesize (TTS), list voices |
| `rag` | 18 | Full RAG pipeline lifecycle: datasets, templates, draft, sync, run, publish, versions |
| `snippet` | 22 | Customized snippet lifecycle: create, import, draft, sync, run, publish, versions |
| `agent` | 17 | Agent guide, config skills/files, drive files/skills, sandbox read/upload |
| `explore` | 2 | Run and stop installed apps |
| `archive` | 2 | List and download workflow run archives |
| `auth` | 4 | Status, import cookies, console login, set tokens |

## Safety

| Mechanism | How it works |
|-----------|-------------|
| **Confirm gates** | Destructive ops (`delete`, `publish`, `restore`, `set_credentials`, plugin install, trigger create/enable, tag bind/unbind, workflow-tool refresh/delete, …) require `confirm=true` / `--yes`. Without it: exit code `4`. Graphs with code nodes also need confirm unless `DIFYWF_CODE_NODES=allow`. |
| **Offline validation** | `sync_draft` validates structure, variable refs, connectivity, and cycles *before* hitting the API — including iteration/loop inner nodes, `custom-note` stickies, and modern multi-case if-else. Errors abort with exit `5`. Stale hashes are `VALIDATION_FAILED` and retryable. Omitting env vars keeps current draft values. |
| **Dry-run** | `--dry-run` on `sync_draft` returns a structural diff without saving. |
| **Private URLs** | `http-request` nodes targeting private/loopback hosts warn (`PRIVATE_URL`). `yaml_url` imports to private hosts are rejected unless `DIFYWF_ALLOW_PRIVATE_URL=1`. |
| **Audit log** | Every action appends to `~/.difywf/audit.jsonl` (nested secrets/graphs redacted, mode `0600`). |
| **Auto-refresh** | Cookie sessions auto-refresh on 401 via the refresh-token cookie, with server-side rotation persisted. Console cookies cover run/stop/upload/deps/workspace; OpenAPI is fallback. |
| **HTTP MCP lock** | Streamable HTTP binds `127.0.0.1` by default. Non-loopback binds require `DIFYWF_MCP_TOKEN`. Host allowlist + 2MB body cap. |
| **Secret store** | `~/.difywf/hosts.json` is `0600`. On macOS, cookies/tokens prefer the OS keychain unless `DIFYWF_HOME` is set. |

**Error/exit codes:** `USAGE_ERROR(2)`, `AUTH_REQUIRED(3)`, `CONFIRM_REQUIRED(4)`,
`VALIDATION_FAILED(5)`, `RBAC_DENIED(6)`, `NOT_FOUND(7)`, `DSL_VERSION_MISMATCH(8)`,
`RATE_LIMITED(9)`, `SERVER_ERROR(10)`, `NETWORK_ERROR(11)`. Check `error.retryable`
before retrying.

## Environment

See [`.env.example`](.env.example). Common knobs:

| Variable | Purpose |
|----------|---------|
| `DIFY_API_BASE` | Dify instance URL (default `https://cloud.dify.ai`) |
| `DIFY_CONSOLE_COOKIE` | Cookie header or cookie-editor JSON for non-interactive bootstrap |
| `DIFY_CONSOLE_EMAIL` / `DIFY_CONSOLE_PASSWORD` | Headless `auth login-console` |
| `DIFY_CONSOLE_PASSWORD_ENCODING` | `plain` (default) or `base64` for legacy login payloads |
| `DIFYWF_HOME` | Config + audit directory (default `~/.difywf`) |
| `DIFYWF_MCP_TRANSPORT` / `DIFYWF_MCP_HOST` / `DIFYWF_MCP_PORT` / `DIFYWF_MCP_TOKEN` | Streamable HTTP MCP |
| `DIFYWF_CODE_NODES` | `confirm` (default), `allow`, or `forbid` |
| `DIFYWF_ALLOW_PRIVATE_URL` | Set `1` to allow `yaml_url` imports to private hosts |

## Develop

```bash
npm test            # 99 unit tests
npm run typecheck   # tsc --noEmit
npm run smoke:mcp   # MCP stdio smoke (153 tools, JSON-RPC handshake)
npm run smoke:mcp:http   # MCP Streamable HTTP smoke (stateless POST /mcp)
```

No build step. Source runs directly via Node's type stripping. GitHub Actions
runs typecheck, unit tests, and both MCP smokes on every push to `main`.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).

<div align="center">

**If this saves you time, a ⭐ is the best thank-you.**

Built for agents, by agents.

</div>
