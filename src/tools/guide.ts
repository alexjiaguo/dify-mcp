// Self-onboarding playbook returned by agent.guide / difywf agent guide and
// the difywf://guide MCP resource. Written for LLM agents, not humans.

const SECTIONS: Record<string, string> = {
  overview: `# difywf — agent guide
You are using difywf to author Dify workflows without the web UI. Everything a
UI user can do — create apps, edit graphs, test, publish — is a tool call.

Surfaces: CLI (\`difywf <ns> <verb> [flags]\`) and MCP tools (same names, dots
become underscores: \`workflow.sync_draft\` -> \`workflow_sync_draft\`). Both
return the same contract: { "ok": bool, "data": ..., "error": { "code",
"message", "retryable" } }. Parse this JSON; never scrape human text.

Targets: Dify v1.x, DSL version 0.7.0, workflow engine graphon 0.6.0.
App modes: workflow | chatflow (advanced-chat) | chat | agent (agent-chat) | completion.

Auth: OpenAPI surface (/openapi/v1) needs an OpenAPI token (device flow via
\`difywf auth login\`, or DIFY_OPENAPI_TOKEN). The authoring surface
(/console/api) uses cookie+CSRF auth (not Bearer): capture cookies via
\`difywf auth import-cookies --file cookies.json\` (browser cookie-editor
JSON export; auto-picks the 3 auth cookies), \`difywf auth login-console\`
(email/password), or \`difywf auth token --console-cookie\` (raw Cookie header).
difywf stores and auto-refreshes them via the refresh_token cookie. Base URL: --base-url,
DIFY_API_BASE, or the active host in ~/.difywf/hosts.json. Check with \`difywf auth status\`.`,

  quickstart: `# Golden path: spec -> published workflow
1. app.list / app.get — find or create the app (app.create with mode).
2. workflow.node_defaults — fetch the schema for each node type you will use.
3. Build the graph: { nodes: [{id, data:{type, ...}}], edges: [{source, target, sourceHandle, targetHandle}] }.
   - Node ids: unique strings. Every graph needs exactly one start node.
   - References: templates use {{#nodeId.varName#}}; selectors use ["nodeId","varName"].
   - A node may only reference nodes upstream of it (no forward refs, no cycles).
4. workflow.validate — offline check. Fix every error-level issue.
5. workflow.sync_draft with dry_run=true — review the diff, then sync for real.
6. workflow.run_draft with inputs — read the events; fix and repeat.
7. workflow.publish with confirm=true — requires a model provider to be
   configured first (provider.list / provider.set_credentials).
If sync_draft fails with a stale-hash error: refetch workflow.get_draft and
retry with the fresh hash (error is marked retryable).`,

  nodes: `# Node types (fetch full schema per type via workflow.node_defaults)
start, end, answer, llm, knowledge-retrieval, question-classifier, if-else,
code, template-transform, http-request, tool, agent, iteration, loop,
variable-aggregator, parameter-extractor, assigner, human-input, datasource,
trigger_schedule, trigger_webhook, trigger_plugin.

Minimal required fields per type (validator enforces these):
- start: variables[]   end: outputs[]   answer: answer
- llm: model{provider,name,mode}, prompt_template[]
- code: code_language, code, outputs   http-request: method, url
- knowledge-retrieval: query_variable_selector, dataset_ids
- if-else: non-empty cases[] OR legacy conditions + logical_operator
  variable-aggregator: variables
- tool: provider_id, provider_type, tool_name
- parameter-extractor: query, model, parameters   assigner: items
- iteration: iterator_selector, start_node_id   loop: start_node_id
Unknown/plugin types are warnings, not errors - but still validate structure.`,

  errors: `# Error codes (stable; check "retryable" before retrying)
USAGE_ERROR(2) bad args — fix the call.
AUTH_REQUIRED/AUTH_EXPIRED(3) no/invalid token — see auth section.
CONFIRM_REQUIRED(4) destructive op needs confirm=true (CLI: --yes).
VALIDATION_FAILED(5) graph has error-level issues — fix and revalidate.
RBAC_DENIED(6) token lacks the named permission — ask a human to grant it.
NOT_FOUND(7) wrong app/node/task id or wrong workspace.
DSL_VERSION_MISMATCH(8) server DSL version drifted from 0.7.0 — stop, report.
RATE_LIMITED(9)/SERVER_ERROR(10)/NETWORK_ERROR(11) — retryable, back off.`,

  safety: `# Safety rules — follow strictly
- Destructive ops (publish, app.delete, provider.set_credentials) require
  confirm=true. Do not set it unless the human's instruction clearly implies it.
- Prefer dry_run=true before sync_draft on apps you did not create.
- Graphs containing code nodes execute code server-side. Say so when you add one.
- Never exfiltrate secrets: env/conversation variables and provider credentials
  may contain keys. Do not copy them into prompts, logs, or other apps.
- Every action is written to ~/.difywf/audit.jsonl.`,
  more: `# More surfaces (Phase 3)
Beyond app workflows, difywf drives the rest of the Dify console surface:

- Annotations (annotation.*): list/add/delete plus reply enable/disable (indexes),
  settings get/update, CSV export, batch-import (+ status poll), hit histories.
- RAG pipelines (rag.*): list_datasets/templates plus full lifecycle - create
  dataset (yaml), get/sync draft, node_defaults, run draft/published, run_node,
  stop, publish, versions list/get/update/restore/delete. Treat a pipeline_id
  like an app_id for the authoring loop.
- Customized snippets (snippet.*): workspace CRUD (list/create/get/update/delete/
  export/import/check_deps) plus a full workflow surface (get/sync draft,
  node_defaults, publish, versions, run_draft/run_node/stop, runs list/get/
  node-executions). Snippets are reusable workflow fragments.
- Agent config / drive / sandbox (agent.*): config manifest/skills/files (upload),
  drive files/skills (inspect/preview/download), and per-agent sandbox
  info/files/read/upload. Multipart uploads (annotation batch_import, agent
  skill/file/sandbox uploads) take a file payload object; exact multipart shape
  is finalized in the live-verification step.

These mirror the app-workflow tools: same contract, same confirm gates, same
audit log. Fetch node_defaults before authoring rag/snippet graphs too.`,
};

export function guideText(section?: string): string {
  const key = section && section !== "all" ? section : null;
  if (key && SECTIONS[key]) return SECTIONS[key];
  if (key) {
    return `Unknown section '${section}'. Available: ${Object.keys(SECTIONS).join(", ")}, all.\n\n${SECTIONS.overview}`;
  }
  return Object.values(SECTIONS).join("\n\n---\n\n");
}
