// Offline graph validation, aligned to Dify's three frontend layers:
// (1) node config -> (2) variable references -> (3) connectivity, plus cycle
// detection. Runs without any API call; optionally enriched with the server's
// default-workflow-block-configs for per-type schema checks.
//
// ponytail: the REQUIRED table is a pragmatic minimal subset grounded in real
// Dify fixtures. Unknown/uncertain node types are skipped with a warning, not
// errored. Runtime-fetched node defaults supersede this table.

export type GraphNode = {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
};
export type GraphEdge = {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  [k: string]: unknown;
};
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type Issue = {
  level: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
};

// Fields verified against api/tests/fixtures/workflow/*.yml in langgenius/dify.
const REQUIRED: Record<string, string[]> = {
  start: ["variables"],
  end: ["outputs"],
  answer: ["answer"],
  llm: ["model", "prompt_template"],
  code: ["code_language", "code", "outputs"],
  "http-request": ["method", "url"],
  "template-transform": ["template"],
  "knowledge-retrieval": ["query_variable_selector", "dataset_ids"],
  "question-classifier": ["query_variable_selector", "classes"],
  "if-else": ["conditions", "logical_operator"],
  "variable-aggregator": ["variables"],
  tool: ["provider_id", "provider_type", "tool_name"],
  "parameter-extractor": ["query", "model", "parameters"],
  assigner: ["items"],
  iteration: ["iterator_selector", "start_node_id"],
  loop: ["start_node_id"],
};

const KNOWN_TYPES = new Set([
  ...Object.keys(REQUIRED),
  "iteration",
  "loop",
  "tool",
  "parameter-extractor",
  "assigner",
  "variable-assigner",
  "agent",
  "human-input",
  "datasource",
  "knowledge-index",
  "trigger_schedule",
  "trigger_webhook",
  "trigger_plugin",
]);

// Prefixes that are not node ids in {{#...#}} references.
const REF_SKIP = new Set(["sys", "env", "conversation"]);

const VAR_REF = /\{\{#([A-Za-z0-9_-]+)\.([A-Za-z0-9_.\[\]-]+)#\}\}/g;

const nodeType = (n: GraphNode): string | undefined =>
  (n.data?.type as string | undefined) ?? n.type;

export function validateGraph(
  graph: Graph,
  opts?: { defaults?: Record<string, unknown> },
): Issue[] {
  const issues: Issue[] = [];
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const byId = new Map<string, GraphNode>();

  // --- structure ---
  for (const n of nodes) {
    if (!n.id) {
      issues.push({ level: "error", code: "MISSING_NODE_ID", message: "node missing id" });
      continue;
    }
    if (byId.has(n.id)) {
      issues.push({ level: "error", code: "DUPLICATE_NODE_ID", message: `duplicate node id '${n.id}'`, nodeId: n.id });
    }
    byId.set(n.id, n);
    const t = nodeType(n);
    if (!t) {
      issues.push({ level: "error", code: "MISSING_NODE_TYPE", message: `node '${n.id}' has no type`, nodeId: n.id });
    } else if (!KNOWN_TYPES.has(t) && !opts?.defaults?.[t]) {
      issues.push({ level: "warning", code: "UNKNOWN_NODE_TYPE", message: `node '${n.id}' type '${t}' not recognized; skipped per-type checks`, nodeId: n.id });
    }
    if (!n.data || typeof n.data !== "object") {
      issues.push({ level: "error", code: "MISSING_NODE_DATA", message: `node '${n.id}' missing data object`, nodeId: n.id });
    }
  }

  const roots = nodes.filter((n) => {
    const t = nodeType(n);
    return t === "start" || (t !== undefined && t.startsWith("trigger"));
  });
  if (roots.length === 0) {
    issues.push({ level: "error", code: "MISSING_START", message: "graph has no start/trigger node" });
  }
  if (roots.filter((n) => nodeType(n) === "start").length > 1) {
    issues.push({ level: "error", code: "MULTIPLE_START", message: "graph has more than one start node" });
  }

  // --- edges ---
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    for (const [role, id] of [["source", e.source], ["target", e.target]] as const) {
      if (id && !byId.has(id)) {
        issues.push({ level: "error", code: "DANGLING_EDGE", message: `edge '${e.id ?? "?"}' ${role} references unknown node '${id}'` });
      }
    }
    if (e.source && e.target) {
      adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
    }
  }

  // --- cycles + reachability ---
  const rootIds = roots.map((r) => r.id);
  const reachable = new Set<string>();
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of adj.get(id) ?? []) queue.push(next);
  }
  for (const n of nodes) {
    if (!reachable.has(n.id) && rootIds.length > 0) {
      issues.push({ level: "error", code: "UNREACHABLE_NODE", message: `node '${n.id}' is not reachable from start`, nodeId: n.id });
    }
  }
  for (const cycleNode of findCycle(nodes.map((n) => n.id), adj)) {
    issues.push({ level: "error", code: "CYCLE", message: `cycle detected involving node '${cycleNode}'`, nodeId: cycleNode });
  }

  // --- per-type required fields ---
  for (const n of nodes) {
    const t = nodeType(n);
    if (!t || !n.data) continue;
    const required = requiredFields(t, opts?.defaults);
    for (const field of required) {
      if (n.data[field] === undefined) {
        issues.push({ level: "error", code: "MISSING_REQUIRED_FIELD", message: `node '${n.id}' (${t}) missing required field '${field}'`, nodeId: n.id });
      }
    }
  }

  // --- variable references ---
  const ancestors = buildAncestors(nodes.map((n) => n.id), adj);
  for (const n of nodes) {
    if (!n.data) continue;
    for (const ref of collectRefs(n.data)) {
      if (REF_SKIP.has(ref)) continue;
      if (!byId.has(ref)) {
        issues.push({ level: "error", code: "BAD_VAR_REF", message: `node '${n.id}' references unknown node '${ref}'`, nodeId: n.id });
        continue;
      }
      if (ref === n.id) {
        issues.push({ level: "error", code: "BAD_VAR_REF", message: `node '${n.id}' references itself`, nodeId: n.id });
        continue;
      }
      // ponytail: ignores loop/iteration scoped-variable exceptions; a scoped
      // reference inside a loop body may false-positive here. Refine when hit.
      if (!ancestors.get(n.id)?.has(ref)) {
        issues.push({ level: "error", code: "FORWARD_VAR_REF", message: `node '${n.id}' references '${ref}', which is not upstream of it`, nodeId: n.id });
      }
    }
  }

  return issues;
}

function requiredFields(t: string, defaults?: Record<string, unknown>): string[] {
  // Runtime-fetched defaults win when they declare required keys.
  const fromServer = defaults?.[t];
  if (fromServer && typeof fromServer === "object") {
    const req = (fromServer as Record<string, unknown>).required;
    if (Array.isArray(req)) return req.filter((x): x is string => typeof x === "string");
  }
  return REQUIRED[t] ?? [];
}

// Collects referenced node ids from {{#node.var#}} templates and from
// *_selector arrays like ["nodeId", "varName"] used by outputs/inputs.
function collectRefs(data: Record<string, unknown>): Set<string> {
  const refs = new Set<string>();
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === "string") {
      VAR_REF.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = VAR_REF.exec(v))) refs.add(m[1]);
      return;
    }
    if (Array.isArray(v)) {
      if (key && key.endsWith("_selector") && typeof v[0] === "string") refs.add(v[0]);
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) walk(val, k);
    }
  };
  walk(data);
  return refs;
}

function buildAncestors(ids: string[], adj: Map<string, string[]>): Map<string, Set<string>> {
  // ancestors[x] = set of nodes that can reach x.
  const ancestors = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  // Reverse BFS from every node is O(V*E); fine for workflow-sized graphs.
  const rev = new Map<string, string[]>();
  for (const [src, targets] of adj) {
    for (const t of targets) rev.set(t, [...(rev.get(t) ?? []), src]);
  }
  for (const id of ids) {
    const seen = new Set<string>();
    const queue = [...(rev.get(id) ?? [])];
    while (queue.length) {
      const cur = queue.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of rev.get(cur) ?? []) queue.push(p);
    }
    ancestors.set(id, seen);
  }
  return ancestors;
}

function findCycle(ids: string[], adj: Map<string, string[]>): string[] {
  const inCycle = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 in-stack, 2 done
  const stack: string[] = [];
  const dfs = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const s = state.get(next) ?? 0;
      if (s === 0) {
        dfs(next);
      } else if (s === 1) {
        for (const n of stack.slice(stack.indexOf(next))) inCycle.add(n);
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of ids) if ((state.get(id) ?? 0) === 0) dfs(id);
  return [...inCycle];
}
