// MCP surface: stdio (default) or Streamable HTTP, exposing the same tool
// registry (dots become underscores) plus the difywf://guide resource.
// Stable spec subset only: tools + resources, no elicitation/sampling/roots.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { err } from "./core/contract.ts";
import { runTool, tools } from "./tools/registry.ts";
import { guideText } from "./tools/guide.ts";

const mcpName = (n: string): string => n.replaceAll(".", "_");

// Fresh server per connection: the SDK throws if connect() is called twice on
// one instance, so stateless HTTP builds one per request (cheap: four request
// handlers over a shared tool registry, not per-tool registration). Stdio uses
// a single instance for the process lifetime.
function createMcpServer(): Server {
  const server = new Server(
    { name: "difywf", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: mcpName(t.name),
      description: t.summary,
      inputSchema: t.schema as { type: "object"; properties?: Record<string, unknown>; required?: string[] },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => mcpName(t.name) === req.params.name);
    const result = tool
      ? await runTool(tool, (req.params.arguments ?? {}) as Record<string, unknown>, { _surface: "mcp" })
      : err("USAGE_ERROR", `unknown tool '${req.params.name}'`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      isError: !result.ok,
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "difywf://guide", name: "difywf agent guide", mimeType: "text/markdown", description: "Authoring playbook: golden path, node types, error codes, safety rules" },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: guideText("all") }],
  }));

  return server;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const transportMode = (
  process.env.DIFYWF_MCP_TRANSPORT ?? (process.argv.includes("--http") ? "http" : "stdio")
).toLowerCase();

if (transportMode === "http") {
  startHttpServer(Number(argValue("--port") ?? process.env.DIFYWF_MCP_PORT ?? 3000));
} else {
  await createMcpServer().connect(new StdioServerTransport());
}

// --- Streamable HTTP transport (stateless, one server per request) ---
function startHttpServer(port: number): void {
  const httpServer = createServer((req, res) => {
    handleHttpRequest(req, res).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(e) }, id: null }));
      }
    });
  });
  httpServer.listen(port, () => {
    process.stderr.write(`difywf MCP (Streamable HTTP) listening on http://0.0.0.0:${port}/mcp\n`);
  });
  const shutdown = (): void => { httpServer.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    return writeJsonRpcError(res, 405, -32000, "Method not allowed. POST a JSON-RPC message to /mcp.");
  }
  let parsedBody: unknown;
  try {
    parsedBody = await readBody(req);
  } catch {
    return writeJsonRpcError(res, 400, -32700, "Parse error: request body is not valid JSON.");
  }
  // Stateless: no session id. Each POST is a self-contained JSON-RPC message,
  // so initialize / tools/list / tools/call all work without prior state.
  const mcp = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (e) {
    if (!res.headersSent) {
      writeJsonRpcError(res, 500, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : undefined;
}

function writeJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
