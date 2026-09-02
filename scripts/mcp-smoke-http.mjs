// MCP Streamable HTTP smoke test: start the server in --http mode, then run
// initialize -> tools/list -> tools/call against POST /mcp (stateless).
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = String(9123 + (process.pid % 97));
const server = spawn(process.execPath, [path.join(root, "src", "mcp.ts"), "--http", "--port", PORT], {
  stdio: ["ignore", "pipe", "pipe"],
});

let stderrBuf = "";
const ready = new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error("server did not announce listening")), 15000);
  server.stderr.on("data", (c) => {
    stderrBuf += c.toString();
    if (stderrBuf.includes("listening on")) { clearTimeout(to); resolve(); }
  });
});

const fail = (msg) => { console.error(`SMOKE FAIL: ${msg}`); server.kill("SIGKILL"); process.exit(1); };

const post = (body) =>
  fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

// A Streamable HTTP response may be a single JSON object (application/json) or
// an SSE stream (text/event-stream) whose data: line holds the JSON-RPC msg.
const readResult = async (res) => {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    if (!line) throw new Error(`SSE without data: ${text}`);
    return JSON.parse(line.slice(5).trim());
  }
  if (text === "") return undefined;
  return JSON.parse(text);
};

try {
  await ready;
  console.log("http server ready");

  const health = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "difywf-smoke-http", version: "0.1.0" } } });
  const initRes = await readResult(init);
  if (!initRes?.result?.serverInfo?.name) fail(`initialize bad: ${JSON.stringify(initRes)}`);
  console.log("initialize OK");

  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listRes = await readResult(list);
  const names = (listRes?.result?.tools ?? []).map((t) => t.name);
  if (names.length < 15) fail(`expected >=15 tools, got ${names.length}`);
  for (const req of ["agent_guide", "workflow_validate", "workflow_sync_draft", "workflow_tool_refresh_provider", "app_create"]) {
    if (!names.includes(req)) fail(`missing tool ${req}`);
  }
  console.log(`tools/list OK (${names.length} tools)`);

  const validate = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workflow_validate", arguments: { graph: { nodes: [{ id: "s", data: { type: "start", variables: [] } }], edges: [] } } } });
  const validateRes = await readResult(validate);
  const validatePayload = JSON.parse(validateRes.result.content[0].text);
  if (!validatePayload.ok || validatePayload.data.valid !== true) fail(`workflow_validate bad: ${JSON.stringify(validatePayload)}`);
  console.log("tools/call workflow_validate OK");

  const denied = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "app_delete", arguments: { app_id: "x" } } });
  const deniedRes = await readResult(denied);
  const deniedPayload = JSON.parse(deniedRes.result.content[0].text);
  if (deniedPayload.ok || deniedPayload.error?.code !== "CONFIRM_REQUIRED") fail(`confirm gate not enforced: ${JSON.stringify(deniedPayload)}`);
  console.log("confirm gate OK");

  const get = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "GET" });
  if (get.status !== 405) fail(`GET should be 405, got ${get.status}`);
  console.log("GET 405 OK");
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

server.kill("SIGTERM");
console.log("SMOKE PASS");
process.exit(0);
