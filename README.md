<div align="center">

# dify-mcp

### The most complete MCP server + CLI for [Dify](https://github.com/langgenius/dify)

**138 tools. 16 namespaces. One registry.** Let any AI agent build, test, and ship
Dify workflows autonomously — everything a human can do in the UI, now scriptable.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node >= 23.6](https://img.shields.io/badge/node-%E2%89%A523.6-green.svg)](https://nodejs.org)
[![138 Tools](https://img.shields.io/badge/tools-138-purple.svg)](#tools)
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
MCP server (stdio or Streamable HTTP) any MCP-compatible host can attach. Same 138 tools, same JSON
contract, same safety guarantees.

```
┌──────────────────────────────────────────────────────────┐
│                    dify-mcp                              │
│                                                          │
│   ┌──────────┐    ┌────────────────────┐    ┌─────────┐ │
│   │  CLI     │───▶│   138-tool         │───▶│  Dify   │ │
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
  — so agents never scrape human-readable text.

- **Cookie auth, handled.** Dify's console uses cookie + CSRF double-submit, not
  Bearer tokens. dify-mcp captures, stores, and auto-refreshes the session — including
  the server-side refresh-token rotation that silently invalidates naive clients.

- **Safe by default.** Destructive operations require explicit `confirm=true` /
  `--yes`. Graphs are validated offline before sync. Every mutation is audit-logged.
  `--dry-run` shows diffs without saving.

- **Zero build step.** Runs directly on Node 23.6+ native TypeScript. No compiler,
  no bundler, no transpiler. Clone, install, go.

## Live verified

Every tool category has been tested against **cloud.dify.ai** with real credentials:

- ✅ Full authoring loop: create app → sync draft → run draft → publish → list versions
- ✅ All 16 namespaces exercised: apps, workflows, providers, plugins, triggers,
  snippets, RAG, agents, stats, comments, annotations, audio, files, runs, workspace
- ✅ MCP transport: `tools/call` over stdio and Streamable HTTP with live cookie auth
- ✅ 42 unit tests · typecheck clean · MCP smoke (138 tools)

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

difywf auth status   # confirm: shows base URL + cookie names (values masked)
```

### Build a workflow

```bash
difywf agent guide                          # self-onboarding playbook for agents
difywf app list                             # see your apps
difywf app create --mode workflow --name "my-agent-workflow"

difywf wf node defaults <app-id> llm        # get the schema for an LLM node
difywf wf validate --graph graph.json       # offline: structure, refs, cycles
difywf wf draft sync <app-id> --graph graph.json --dry-run   # preview diff
difywf wf draft sync <app-id> --graph graph.json             # save draft
difywf wf test <app-id> --input query="hello"                # test-run the draft
difywf wf publish <app-id> --yes                             # ship it
```

### Connect your agent (MCP)

Same binary, same 138 tools. Copy-paste the config for your host:

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
difywf mcp serve --http --port 8080
# or via env: DIFYWF_MCP_TRANSPORT=http DIFYWF_MCP_PORT=8080 difywf mcp serve
```

Point any Streamable-HTTP-capable client at `http://<host>:8080/mcp`. Each POST is
a self-contained JSON-RPC message (initialize / tools/list / tools/call); no
session is required. GET and DELETE are rejected with 405.
</details>

> No `difywf` on PATH? Use the absolute path: `node /path/to/dify-mcp/bin/difywf.js mcp serve`.

## Tools

**138 tools across 16 namespaces.** Run `difywf --help` for the full live list, or
`difywf agent guide` for the agent-oriented playbook.

| Namespace | Tools | What it does |
|-----------|-------|-------------|
| `app` | 13 | List, create, update, delete, export, import, copy, rename, convert apps |
| `workflow` | 22 | Get/sync drafts, validate, run, publish, node defaults, variables, versions, HITL |
| `provider` | 3 | List providers, list models, set credentials |
| `plugin` | 1 | List installed plugins |
| `trigger` | 4 | Create, enable, list, webhook triggers; run triggers |
| `workspace` | 4 | List, get, switch workspaces; list members |
| `file` | 1 | Upload files for use in runs |
| `runs` | 4 | List, get, node executions, export run traces |
| `stats` | 5 | Daily conversations/terminals, token costs, app interactions, online users |
| `comment` | 3 | List, add, resolve workflow comments |
| `annotation` | 12 | List, add, delete, reply, settings, export, batch import, hit histories |
| `audio` | 3 | Transcribe (STT), synthesize (TTS), list voices |
| `rag` | 20 | Full RAG pipeline lifecycle: datasets, templates, draft, sync, run, publish, versions |
| `snippet` | 22 | Customized snippet lifecycle: create, import, draft, sync, run, publish, versions |
| `agent` | 16 | Agent config skills/files, drive files/skills, sandbox read/upload |
| `explore` | 2 | Run and stop installed apps |
| `auth` | 2 | Status, login, import cookies |

## Safety

| Mechanism | How it works |
|-----------|-------------|
| **Confirm gates** | Destructive ops (`delete`, `publish`, `restore`, `set_credentials`) require `confirm=true` / `--yes`. Without it: exit code `4`. |
| **Offline validation** | `sync_draft` validates the graph structure, variable refs, connectivity, and cycles *before* hitting the API. Errors abort with exit `5`. |
| **Dry-run** | `--dry-run` on `sync_draft` returns a structural diff without saving. |
| **Audit log** | Every mutation appends to `~/.difywf/audit.jsonl` (secrets redacted). |
| **Auto-refresh** | Cookie sessions auto-refresh on 401 via the refresh-token cookie, with server-side rotation persisted. |

**Error/exit codes:** `USAGE_ERROR(2)`, `AUTH_REQUIRED(3)`, `CONFIRM_REQUIRED(4)`,
`VALIDATION_FAILED(5)`, `RBAC_DENIED(6)`, `NOT_FOUND(7)`, `DSL_VERSION_MISMATCH(8)`,
`RATE_LIMITED(9)`, `SERVER_ERROR(10)`, `NETWORK_ERROR(11)`. Check `error.retryable`
before retrying.

## Develop

```bash
npm run typecheck   # tsc --noEmit
npm test            # 42 unit tests
npm run smoke:mcp   # MCP stdio smoke (138 tools, JSON-RPC handshake)
npm run smoke:mcp:http   # MCP Streamable HTTP smoke (stateless POST /mcp)
```

No build step. Source runs directly via Node's type stripping.

## License

Apache-2.0 — see [LICENSE](LICENSE).

<div align="center">

**If this saves you time, a ⭐ is the best thank-you.**

Built for agents, by agents.

</div>
