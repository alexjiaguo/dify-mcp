# Workflow Graph Templates

Ready-made workflow graph JSON templates you can use to quickly try dify-mcp with a working workflow.

## Templates

| Template | Description | Nodes |
|----------|-------------|-------|
| [`echo-input.json`](./echo-input.json) | Echo — passes the user input straight through | start → end |
| [`simple-llm.json`](./simple-llm.json) | Simple LLM — sends the input to an LLM and returns the response | start → LLM → answer |
| [`rag-pipeline.json`](./rag-pipeline.json) | RAG pipeline — retrieves context from a knowledge base, then asks the LLM to answer using that context | start → knowledge retrieval → LLM → answer |

## Usage

### Validate a template offline

```bash
# The graph is validated automatically when used with --dry-run
difywf wf draft sync --graph examples/simple-llm.json --dry-run
```

### Import into a Dify app

```bash
# Sync the graph to a draft workflow (replace APP_ID and credentials)
difywf wf draft sync \
  --graph examples/simple-llm.json \
  --credentials '{"app_id":"YOUR_APP_ID","api_key":"YOUR_API_KEY"}'
```

### Use with MCP

Pass the graph JSON to any MCP-compatible tool that accepts a `graph` parameter.

## Adapting templates

Each template uses placeholder values you'll need to replace:

- **`YOUR_DATASET_ID`** in `rag-pipeline.json` — replace with your actual Dify dataset ID
- **Model provider/name** — change `openai` / `gpt-4o-mini` to match your configured provider
- **Variable names** — adjust `query`, `answer`, etc. to fit your use case

The templates follow the [Dify workflow graph schema](https://docs.dify.ai/) with `nodes` (typed by `data.type`) and `edges` (connecting `source` → `target`).
