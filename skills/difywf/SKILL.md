---
name: difywf
description: Build, validate, test, publish, debug, and migrate Dify workflows, chatflows, agents, RAG pipelines, knowledge bases, and Personal Access Tokens via the dify-mcp server or difywf CLI. Use when working with Dify apps, workflow graphs, DSL/ifpkg export-import, or Dify automation.
---

# difywf (dify-mcp)

Programmatic control over Dify (1.16–1.20) via **200 tools across 22 namespaces** — identical JSON contract (`{ ok, data }` or `{ ok: false, error: { code, message, retryable } }`) on both MCP and CLI.

## Surfaces

- **MCP attached:** Call tools with underscore names (e.g., `workflow_sync_draft`, `pat_list`). Start with `agent_guide` or read resource `difywf://guide` if you need node schemas or compatibility notes.
- **CLI (no MCP):** Run `difywf <namespace> <verb> [flags]` (e.g., `difywf wf draft sync <app-id> --graph graph.json --dry-run`). Run `difywf agent guide` for the full playbook or `difywf --help` for all commands. For large outputs, pass `--output-file <path>`.

## Auth & Scope Boundary

Check `auth.status` / `difywf auth status` first:

- **Console authoring (`/console/api`):** Required for creating apps, editing/syncing drafts, publishing, DSL/`ifpkg` import/export, and `pat.*` management. Uses Cookie+CSRF (`auth.import_cookies`, `auth.login_console`, or `DIFY_CONSOLE_COOKIE`).
- **OpenAPI (`/openapi/v1`, enabled by default in Dify 1.20+):** Accepts a Personal Access Token (`dpat_...`, managed via `pat.*`) or OAuth device token via `DIFY_OPENAPI_TOKEN`, `DIFY_TOKEN`, `--openapi-token`, or `auth.set_tokens`. Covers resource calls/discovery (`apps`, `:run`, `:stop`, `/events`, `/files`, HITL forms, `workspaces`), **not** authoring or DSL import/export.

## Golden Path: Spec → Published Workflow

1. **Locate or create app:** `app.list` / `app.get` / `app.create` (`workflow` | `advanced-chat` | `chat` | `agent-chat` | `completion`).
2. **Fetch node schemas:** `workflow.node_defaults` for each node type you plan to wire.
3. **Build graph:** `{ nodes: [{ id, data: { type, ... } }], edges: [{ source, target, sourceHandle, targetHandle }] }` with exactly one `start` node, template refs `{{#nodeId.var#}}`, selectors `["nodeId", "var"]`, and upstream-only references (no cycles).
4. **Validate offline:** `workflow.validate` — fix every error-level issue before touching the server.
5. **Preview & sync:** `workflow.sync_draft` with `dry_run=true` (`--dry-run`), review the diff, then sync without `dry_run`. On stale-hash (`VALIDATION_FAILED`), refetch `workflow.get_draft` and retry.
6. **Test-run:** `workflow.run_draft` with inputs and inspect events (`workflow.events` / `runs.node_executions`).
7. **Publish:** `workflow.publish` with `confirm=true` (`--yes`) once a model provider is configured (`provider.list`).

## Safety Rules

- **Confirm gates:** Destructive or credential-minting ops (`workflow.publish`, `app.delete`, `app.import`, `app.restore`, `pat.create`, `pat.revoke`, `provider.set_credentials`, `skill.delete`) require `confirm=true` (`--yes`). Only pass it when the user's request clearly authorizes the action.
- **DSL version:** Expected DSL is `0.7.0`. If a server reports `DSL_VERSION_MISMATCH`, stop and report it — never hand-edit DSL versions.
- **Env/conversation variables:** Manage via dedicated `workflow.*_variable` tools; do not overwrite them via raw draft payloads.
