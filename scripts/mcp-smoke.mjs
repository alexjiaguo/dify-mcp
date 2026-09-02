// MCP stdio smoke test: initialize -> tools/list -> tools/call x2.
// No SDK here; speaks newline-delimited JSON-RPC like any MCP client.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = spawn(process.execPath, [path.join(root, "src", "mcp.ts")], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map();
let nextId = 1;

server.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
  });

const notify = (method) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  server.kill();
  process.exit(1);
};

const init = await send("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "difywf-smoke", version: "0.1.0" },
});
if (!init?.serverInfo?.name) fail("initialize returned no serverInfo");
notify("notifications/initialized");

const list = await send("tools/list", {});
const names = (list?.tools ?? []).map((t) => t.name);
if (names.length < 15) fail(`expected >=15 tools, got ${names.length}`);
for (const required of ["agent_guide", "workflow_validate", "workflow_sync_draft", "workflow_publish", "workflow_tool_refresh_provider", "app_create"]) {
  if (!names.includes(required)) fail(`missing tool ${required}`);
}
console.log(`tools/list OK (${names.length} tools)`);

const guide = await send("tools/call", { name: "agent_guide", arguments: {} });
const guidePayload = JSON.parse(guide.content[0].text);
if (!guidePayload.ok || !String(guidePayload.data).includes("Golden path")) fail("agent_guide bad payload");
console.log("tools/call agent_guide OK");

const validate = await send("tools/call", {
  name: "workflow_validate",
  arguments: { graph: { nodes: [{ id: "s", data: { type: "start", variables: [] } }], edges: [] } },
});
const validatePayload = JSON.parse(validate.content[0].text);
if (!validatePayload.ok || validatePayload.data.valid !== true) fail("workflow_validate bad payload");
console.log("tools/call workflow_validate OK");

const denied = await send("tools/call", { name: "app_delete", arguments: { app_id: "x" } });
const deniedPayload = JSON.parse(denied.content[0].text);
if (deniedPayload.ok || deniedPayload.error?.code !== "CONFIRM_REQUIRED") fail("confirm gate not enforced");
console.log("confirm gate OK");

server.kill();
console.log("SMOKE PASS");
process.exit(0);
