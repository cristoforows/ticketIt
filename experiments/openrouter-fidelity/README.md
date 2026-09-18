# openrouter-fidelity

M1.14 ([#25](https://github.com/cristoforows/ticketIt/issues/25)) — feasibility
experiment S4 (see
[docs/integration-feasibility.md](../../docs/integration-feasibility.md)):
a local fake OpenRouter `/chat/completions` server plus a fidelity matrix
for the actual pinned LangChain OpenRouter adapter (`@langchain/openrouter`,
class `ChatOpenRouter`). No real credentials, no real provider calls — see
`experiments/README.md` for workspace rules.

Full findings, versions, and the matrix are recorded in
[docs/evidence/m1/25-openrouter-fidelity.md](../../docs/evidence/m1/25-openrouter-fidelity.md).

## What's here

- `src/server.ts` — `FakeOpenRouterServer`: a `node:http` server on
  `127.0.0.1` (ephemeral port) that serves named fixtures in JSON
  (`stream:false`) or SSE (`stream:true`) shape, keyed by the request
  body's `model` field. Records every request (headers minus
  `authorization`, parsed body) for assertions. Can truncate a response
  (JSON or SSE) after N bytes/chunks by destroying the socket.
- `src/fixtures.ts` — six fixtures constructed from OpenRouter's
  documentation (cited inline; not captured from a real response): (a)
  tool call, (b) URL citation annotations over Unicode content, (c) usage
  accounting fields on the finish_reason chunk, (d) a usage-only final SSE
  chunk (empty `choices`), (e) a truncated stream/body, (f) an in-band
  mid-stream error chunk.
- `test/` — runs every fixture through `ChatOpenRouter` in both `invoke`
  and `stream` modes and asserts exactly where each field surfaces or is
  lost.
- `scripts/verify-default-retry.ts` — a slow (~100s), non-`npm test`
  manual check of `ChatOpenRouter`'s default retry behavior (see the
  evidence file's "Observed limitations"). Run directly:
  `node --import tsx scripts/verify-default-retry.ts`.

## Verify

```sh
npm ci
npm test
```

`npm test` runs in a few seconds; it does not run
`scripts/verify-default-retry.ts`.
