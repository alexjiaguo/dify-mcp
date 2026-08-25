import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGraph, type Graph, type Issue } from "../src/graph/validate.ts";

const codes = (issues: Issue[]): string[] => issues.filter((i) => i.level === "error").map((i) => i.code);
const missing = (issues: Issue[]): string[] =>
  issues.filter((i) => i.level === "error" && i.code === "MISSING_REQUIRED_FIELD").map((i) => i.message);

// Wrap a node under test in start -> uut -> end so it is reachable and any
// upstream selector refs resolve.
function wrap(nodeData: Record<string, unknown>): Graph {
  return {
    nodes: [
      { id: "start", data: { type: "start", variables: [{ variable: "query", type: "text-input", required: true }] } },
      { id: "uut", data: nodeData },
      { id: "end", data: { type: "end", outputs: [] } },
    ],
    edges: [
      { id: "e1", source: "start", target: "uut" },
      { id: "e2", source: "uut", target: "end" },
    ],
  };
}

test("tool node: complete -> no errors", () => {
  const issues = validateGraph(wrap({
    type: "tool", provider_id: "google", provider_type: "builtin", tool_name: "search", tool_parameters: {},
  }));
  assert.deepEqual(codes(issues), []);
});

test("tool node: missing provider_id/tool_name -> MISSING_REQUIRED_FIELD", () => {
  const errs = missing(validateGraph(wrap({ type: "tool", provider_type: "builtin" })));
  assert.ok(errs.some((m) => m.includes("provider_id")), errs.join("; "));
  assert.ok(errs.some((m) => m.includes("tool_name")), errs.join("; "));
});

test("parameter-extractor: complete -> no errors", () => {
  const issues = validateGraph(wrap({
    type: "parameter-extractor",
    query: ["start", "query"],
    model: { provider: "openai", name: "gpt-4o-mini", mode: "chat" },
    parameters: [{ name: "city", type: "string", description: "x" }],
  }));
  assert.deepEqual(codes(issues), []);
});

test("parameter-extractor: missing model/parameters -> MISSING_REQUIRED_FIELD", () => {
  const errs = missing(validateGraph(wrap({ type: "parameter-extractor", query: ["start", "query"] })));
  assert.ok(errs.some((m) => m.includes("model")), errs.join("; "));
  assert.ok(errs.some((m) => m.includes("parameters")), errs.join("; "));
});

test("assigner: with items -> no errors", () => {
  const issues = validateGraph(wrap({
    type: "assigner",
    items: [{ variable_selector: ["start", "query"], operation: "set", value: "x" }],
  }));
  assert.deepEqual(codes(issues), []);
});

test("assigner: missing items -> MISSING_REQUIRED_FIELD", () => {
  assert.ok(missing(validateGraph(wrap({ type: "assigner" }))).some((m) => m.includes("items")));
});

test("iteration: complete -> no errors", () => {
  const issues = validateGraph(wrap({
    type: "iteration", iterator_selector: ["start", "query"], start_node_id: "iter_start",
  }));
  assert.deepEqual(codes(issues), []);
});

test("iteration: missing iterator_selector/start_node_id -> MISSING_REQUIRED_FIELD", () => {
  const errs = missing(validateGraph(wrap({ type: "iteration" })));
  assert.ok(errs.some((m) => m.includes("iterator_selector")), errs.join("; "));
  assert.ok(errs.some((m) => m.includes("start_node_id")), errs.join("; "));
});

test("loop: complete -> no errors", () => {
  assert.deepEqual(codes(validateGraph(wrap({ type: "loop", start_node_id: "loop_start" }))), []);
});

test("iteration sub-graph: container + iteration-start + inner node -> no false errors", () => {
  // Real Dify iteration structure: the container's output_selector names an
  // inner node, the inner node reads the container's scoped `item`, and the
  // inner/start nodes are reachable only via parentId containment (not edges
  // from start). None of these should raise UNREACHABLE_NODE, FORWARD_VAR_REF,
  // or UNKNOWN_NODE_TYPE.
  const graph: Graph = {
    nodes: [
      { id: "start", data: { type: "start", variables: [{ variable: "query", type: "text-input", required: true }] } },
      { id: "src", data: { type: "code", code_language: "python3", code: "x", outputs: { arr: { type: "array[object]" } } } },
      { id: "iter", data: {
        type: "iteration",
        iterator_selector: ["src", "arr"],
        output_selector: ["inner", "text"],
        start_node_id: "iterstart",
      } },
      { id: "iterstart", parentId: "iter", data: { type: "iteration-start", isInIteration: true } },
      { id: "inner", parentId: "iter", data: {
        type: "llm", isInIteration: true, iteration_id: "iter",
        model: {}, prompt_template: [{ role: "user", text: "{{#iter.item#}}" }],
      } },
      { id: "end", data: { type: "end", outputs: [] } },
    ],
    edges: [
      { id: "e1", source: "start", target: "src" },
      { id: "e2", source: "src", target: "iter" },
      { id: "e3", source: "iter", target: "end" },
      { id: "e4", source: "iterstart", target: "inner" },
    ],
  };
  assert.deepEqual(codes(validateGraph(graph)), []);
});

test("loop: missing start_node_id -> MISSING_REQUIRED_FIELD", () => {
  assert.ok(missing(validateGraph(wrap({ type: "loop" }))).some((m) => m.includes("start_node_id")));
});
