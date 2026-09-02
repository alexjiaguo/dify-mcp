# Contributing

Thanks for your interest in dify-mcp! This is a community project - contributions welcome.

## Ways to contribute

- **Bug reports** - open an issue with the command you ran, the output, and your Dify edition (cloud / self-hosted version)
- **Feature requests** - open an issue describing the use case and which Dify API endpoint it maps to
- **New tools** - add a client method in `src/api/console.ts` or `src/api/openapi.ts`, a tool object in `src/tools/registry.ts`, and a positional mapping in `src/cli.ts`
- **Docs** - README improvements, agent setup guides, examples

## Development setup

```bash
git clone https://github.com/alexjiaguo/dify-mcp.git
cd dify-mcp
npm install
npm test              # 49 unit tests
npm run typecheck     # tsc --noEmit
npm run smoke:mcp     # MCP stdio smoke
```

No build step. Source runs directly on Node 23.6+ native TypeScript.

## Adding a tool

1. **Client method** - add to `src/api/console.ts` (console API) or `src/api/openapi.ts` (OpenAPI surface)
2. **Tool definition** - add to the `tools[]` array in `src/tools/registry.ts` with name, summary, schema, and run function
3. **CLI positional** - add to the `POSITIONALS` map in `src/cli.ts` if the tool takes positional args
4. **Test** - verify with `difywf <namespace> <verb>` against a real Dify instance

Helpers in registry.ts: `req`, `obj`, `pick`, `str`, `num`, `needClient`, `clientAny`.

## Pull requests

- Keep changes scoped to the issue/feature
- Ensure `npm test` and `npm run typecheck` pass
- Live-test new tools against cloud.dify.ai or a self-hosted instance before submitting
