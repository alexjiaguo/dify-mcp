import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bindRequiresToken,
  extractMcpToken,
  hostHeaderAllowed,
  isLoopbackHost,
  mcpTokenMatches,
} from "../src/core/mcp-guard.ts";

test("loopback binds do not require a token", () => {
  assert.equal(bindRequiresToken("127.0.0.1", undefined), undefined);
  assert.equal(bindRequiresToken("localhost", undefined), undefined);
  assert.match(bindRequiresToken("0.0.0.0", undefined) ?? "", /DIFYWF_MCP_TOKEN/);
  assert.equal(bindRequiresToken("0.0.0.0", "secret"), undefined);
});

test("mcpTokenMatches is exact and rejects missing tokens", () => {
  assert.equal(mcpTokenMatches(undefined, undefined), true);
  assert.equal(mcpTokenMatches("a", undefined), true);
  assert.equal(mcpTokenMatches(undefined, "a"), false);
  assert.equal(mcpTokenMatches("a", "a"), true);
  assert.equal(mcpTokenMatches("a", "b"), false);
});

test("extractMcpToken reads Bearer and x-difywf-token", () => {
  assert.equal(extractMcpToken({ authorization: "Bearer abc" }), "abc");
  assert.equal(extractMcpToken({ "x-difywf-token": "xyz" }), "xyz");
});

test("anonymous loopback requires a loopback Host header", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(hostHeaderAllowed("127.0.0.1:8080", "127.0.0.1", false), true);
  assert.equal(hostHeaderAllowed("evil.example", "127.0.0.1", false), false);
  assert.equal(hostHeaderAllowed("dify-mcp:3000", "0.0.0.0", true), true);
});
