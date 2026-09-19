# M1.14 — OpenRouter fixture server and adapter fidelity matrix

## Purpose

Prove the adapter half of feasibility experiment S4 ("OpenRouter payload
fidelity") from
[docs/integration-feasibility.md](../../integration-feasibility.md), for
[M1.14 — OpenRouter fixture server and adapter fidelity matrix
(#25)](https://github.com/cristoforows/ticketIt/issues/25): run the actual
pinned LangChain OpenRouter chat model adapter against a local fake
OpenRouter server in both `invoke` and `stream` modes, across fixtures for
tool calls, URL citation annotations over Unicode content, usage-accounting
fields (reasoning/cached/cache-write tokens, cost), a usage-only final SSE
chunk, a truncated stream, and a mid-stream error — and record exactly
where each field surfaces or is lost. This informs open decision
[D7](../../open-decisions.md) (native model unselected) and the usage
accounting rules for M9 ([docs/usage-accounting.md](../../usage-accounting.md)).
No real OpenRouter credentials or network calls are used anywhere in this
slice, per `experiments/README.md`.

## Exact versions

- Node: `v26.9.0` (matches `experiments/.nvmrc` and this package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- `typescript`: `7.0.2` (devDependency, pinned exact)
- `tsx`: `4.23.13` (devDependency, pinned exact)
- `@types/node`: `26.6.1` (devDependency, pinned exact)
- `@langchain/openrouter`: `0.4.13` (dependency, pinned exact — latest on
  the npm registry at review time; confirmed via `npm view
  @langchain/openrouter dist-tags` and installed/resolved as `0.4.13` in
  the committed `package-lock.json`). Exports class `ChatOpenRouter` from
  its package root.
- `@langchain/core`: `1.2.11` (dependency, pinned exact — the peer
  dependency range `@langchain/openrouter@0.4.13` declares is
  `^1.0.0`; `1.2.11` was the latest matching release at review time).
- Transitively resolved (via `@langchain/openrouter`'s own dependencies,
  not directly pinned by this package, but fixed by the committed
  `package-lock.json`): `openai@7.18.0`, `eventsource-parser@4.1.1`.
- Test runner: Node's built-in `node --test`, loaded via `node --import
  tsx --test`. See `experiments/README.md` ("Why this runner").

## Reproducible commands

```sh
cd experiments/openrouter-fidelity
rm -rf node_modules
npm ci
npm test
```

Fast (~4–5s), no environment variables or fixture files beyond what's
committed. Optional, slow (~90–100s) manual check of `ChatOpenRouter`'s
*default* retry behavior against a persistently-failing request (not part
of `npm test`; see "Observed limitations"):

```sh
node --import tsx scripts/verify-default-retry.ts
```

Type-check: `npm run typecheck` (clean, no errors).

## Documentation research (unverified)

Findings below are drawn from reading OpenRouter's public documentation
and the adapter's own shipped source/type declarations (`npm pack
@langchain/openrouter@0.4.13`, `npm pack @langchain/openai@1.5.13`, `npm
pack @langchain/core@1.2.11`, inspected under
`dist/**/*.{js,d.ts}`). Reading source is closer to "observed" than pure
prose docs, but nothing here reflects an actual real-provider response —
that remains unverified until the M7 smoke test.

- **Chat completions / streaming wire shape, usage-only final chunk, SSE
  keep-alive comments**:
  <https://openrouter.ai/docs/api-reference/streaming>. Usage "is always
  included in the final chunk when streaming"; comment lines (`:
  OPENROUTER PROCESSING`) may appear and must be skipped before JSON
  parsing (our fake server doesn't emit these; documented for
  completeness — the adapter's own `OpenRouterJsonParseStream`
  (`dist/utils/stream.js`) enqueues `undefined` for any SSE event whose
  `data` field fails `JSON.parse`, which a comment-only event would, so it
  would already be silently skipped without special-casing).
- **In-band mid-stream error shape**: same page. When an error occurs
  after streaming has begun, OpenRouter keeps HTTP 200 (headers already
  sent) and sends an SSE `data:` event shaped like `{"id":...,
  "error":{"code":"server_error","message":"..."},
  "choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}`.
  This is the documented shape our fixture (f) uses.
- **Usage accounting fields**:
  <https://openrouter.ai/docs/guides/guides/usage-accounting>. The
  page's own example response's `usage` object: `prompt_tokens`,
  `completion_tokens`, `total_tokens`, `cost`, `cost_details.
  upstream_inference_cost`, `prompt_tokens_details.{cached_tokens,
  cache_write_tokens, audio_tokens}`, `completion_tokens_details.
  reasoning_tokens`. The page states the (older) `usage: {include:
  true}` request parameter is now deprecated and has "no effect. Full
  usage details are now always included automatically in every
  response." — i.e., no request-body flag is documented as required
  anymore. The adapter's own request types
  (`OpenRouter.ChatGenerationParams` in `dist/api-types.d.ts`) do *not*
  model a top-level `usage` request field at all; they *do* model
  `stream_options?: {include_usage?: boolean}` (the OpenAI-standard
  streaming-usage flag).
- **Web search URL citation annotations**:
  <https://openrouter.ai/docs/guides/features/plugins/web-search>.
  `annotations: [{type: "url_citation", url_citation: {url, title,
  content, start_index, end_index}}]` on the assistant message. `content`
  is "Added by OpenRouter if available". The docs do not state whether
  `start_index`/`end_index` are UTF-16 code-unit offsets or Unicode
  codepoint offsets, or how annotations are split across streaming
  deltas — both are constructed assumptions in fixture (b), stated
  explicitly in `src/fixtures.ts` and below.
- **Adapter usage-accounting option ("research and record it", per the
  issue)**: `ChatOpenRouter` (`@langchain/openrouter@0.4.13`) has **no
  dedicated boolean** for OpenRouter's request-level usage-accounting
  flag. `invocationParams()` (`dist/chat_models/index.js`) builds the
  request body from a fixed field list that does **not** include `usage`
  or `stream_options`; the only way to send either documented mechanism
  is the generic `modelKwargs: Record<string, unknown>` passthrough,
  which is spread onto the body last (`...this.modelKwargs`). This
  experiment enables usage accounting via `modelKwargs: {usage:
  {include: true}, stream_options: {include_usage: true}}` — both
  mechanisms at once, since one is documented-but-deprecated and the
  other is the adapter's own typed (if unexposed-as-a-dedicated-option)
  request field. `usage.test.ts` asserts the fake server actually
  received both fields verbatim. Separately, `streamUsage` (constructor
  field, default `true`) does **not** control the request; it only gates
  whether `_streamResponseChunks` copies a chunk's `data.usage` onto
  `chunk.usage_metadata` if usage happens to be present.
- **Where annotations would be handled, if at all**: `ChatOpenRouter`
  delegates message conversion to `@langchain/openai`'s
  `convertCompletionsMessageToBaseMessage` /
  `convertCompletionsDeltaToBaseMessageChunk`
  (`@langchain/openai@1.5.13`, `dist/converters/completions.js`). Neither
  function references `message.annotations` / `delta.annotations`
  anywhere (confirmed by `grep -rn annotation
  langchain-openai/dist/converters/completions.js` — no matches; the only
  matches for "annotation" in that package are in the unrelated Responses
  API converter and tool files, not the Completions converter
  `ChatOpenRouter` actually uses). `@langchain/openrouter`'s own
  `AssistantMessage` response type (`dist/api-types.d.ts`) has no
  `annotations` field either. `includeRawResponse` (which would attach
  `additional_kwargs.__raw_response`) exists on the shared converter but
  `ChatOpenRouter` never passes it, so no first-class raw-response escape
  hatch exists for this adapter version.
- **`ChatOpenRouter` has no injectable `fetch`/`configuration` option**:
  unlike some other LangChain chat model integrations, `_generate` and
  `_streamResponseChunks` call the global `fetch(...)` directly
  (`dist/chat_models/index.js`); there is no constructor field to supply
  a custom fetch implementation. The only raw-response access path
  identified for a field the adapter drops (e.g. `annotations`, or usage
  delivered via the empty-choices trailing chunk) is monkey-patching
  `globalThis.fetch` to clone the response before returning it. Exercised
  and confirmed working in `test/citations.test.ts`.

## Fixture/stub evidence (observed)

All results below are directly observed by running `npm test` (21/21
passing) in `experiments/openrouter-fidelity/` against
`FakeOpenRouterServer` (127.0.0.1, ephemeral port, `src/server.ts`) and
six constructed fixtures (`src/fixtures.ts`) — never a real OpenRouter
endpoint. `FakeOpenRouterServer` records every request (headers minus
`authorization`, parsed body) for assertions, serves JSON or SSE per the
request's `stream` field, and can truncate a JSON body or an SSE stream
after N bytes/chunks by destroying the socket mid-response
(`test/server.test.ts` covers the server itself independent of the
adapter).

### Fidelity matrix

| Field | `invoke` | `stream` |
| --- | --- | --- |
| **Tool call** | Surfaces fully: `AIMessage.tool_calls[0]` = `{name, args (parsed object), id, type:"tool_call"}`; raw call also on `additional_kwargs.tool_calls[0].function.arguments` (string). No loss. | Surfaces fully after concatenation: per-chunk `tool_call_chunks` (index-keyed, matching OpenAI/OpenRouter streaming convention) merge into the same final `tool_calls`/`additional_kwargs.tool_calls` as invoke. Intermediate chunks show transient `invalid_tool_calls` ("Malformed args.") while `arguments` JSON is still partial — expected, resolves once concatenated. No loss. |
| **Citation url/title/content** | **Lost.** `annotations` is not present anywhere on the resulting `AIMessage` — not in `content`, `additional_kwargs`, `response_metadata`, or `contentBlocks` (confirmed `JSON.stringify(message)` contains no `"url_citation"` substring). Message `content` text itself (including the Unicode before the citation) is preserved exactly. Raw-response access path: monkey-patch `globalThis.fetch` (no injectable fetch option exists) and clone the response — recovers the full `annotations` array with all 5 fields intact. | **Lost**, identically to `invoke` (confirmed on the concatenated stream chunk). Same raw-fetch-clone access path applies in principle; not separately re-exercised for the SSE body in the committed suite (mechanism is identical — clone before the adapter consumes the stream). |
| **Citation offsets correct over Unicode** | N/A on the adapter surface (no annotations reach the message at all, so no offsets to check there). On the **raw recovered** response: this fixture's offsets are constructed as Unicode-codepoint offsets (a stated assumption — OpenRouter's docs don't say which convention is used). Naive JS `content.slice(start_index, end_index)` does **not** recover the cited text once an astral character (a UTF-16 surrogate pair) precedes the span — it lands one code unit off. Codepoint-aware slicing (`Array.from(content).slice(start,end).join("")`) recovers the exact cited text. | Same as `invoke` (annotations lost before offsets are reachable). |
| **Reasoning tokens** | Surfaces at `usage_metadata.output_token_details.reasoning` (= fixture value `6`) and, raw, at `response_metadata.usage.completion_tokens_details.reasoning_tokens`. | Surfaces identically **when usage is attached to the same chunk that carries `finish_reason`** (fixture c's placement). See "usage-only final chunk" row for the placement where this is instead lost entirely. |
| **Cached tokens** | Surfaces at `usage_metadata.input_token_details.cache_read` (= `256`) and raw at `response_metadata.usage.prompt_tokens_details.cached_tokens`. | Same as `invoke`, same placement caveat as reasoning tokens. |
| **Cache-write** | **Not normalized.** `usage_metadata.input_token_details` has no cache-write key (`convertUsageMetadata` in `@langchain/openrouter`'s `dist/converters/messages.js` only maps `cached_tokens`→`cache_read` and `audio_tokens`→`audio` from `prompt_tokens_details`; `cache_write_tokens` is not read). Preserved raw at `response_metadata.usage.prompt_tokens_details.cache_write_tokens` (= `64`). | Same as `invoke` (not normalized, preserved raw), same placement caveat. |
| **Cost** | **Not normalized** — absent from `usage_metadata` and from the adapter's own `ChatGenerationTokenUsage` TypeScript type (no `cost`/`cost_details` field declared there at all). Preserved raw at `response_metadata.usage.cost` (= `0.002145`), `response_metadata.usage.cost_details.upstream_inference_cost` (= `0.0019`), and (invoke only) the legacy `response_metadata.tokenUsage`. | Same as `invoke` when usage rides the finish_reason chunk (preserved raw on `response_metadata.usage`, never normalized). **Entirely lost** if delivered via the separate usage-only trailing chunk instead — see next row. |
| **Usage-only final chunk (empty `choices`)** | N/A as a distinct behavior: a single JSON response has no "trailing chunk"; usage (cost, cache-write, reasoning, cached — everything) surfaces exactly as in the "Cost"/"Reasoning tokens"/"Cached tokens" rows above. | **Entirely lost.** `_streamResponseChunks` does `const choice = data.choices?.[0]; if (!choice?.delta) continue;` — when `choices` is `[]`, this `continue`s and the chunk never becomes a `ChatGenerationChunk` at all. Confirmed: the fake server sends 3 SSE data chunks (content, finish_reason, then the empty-choices usage chunk); the adapter yields only 2 to the caller. The concatenated result has `usage_metadata === undefined` and `response_metadata.usage` stuck at `{}` — zero trace of the usage-only chunk's data, even though the exact same fields work correctly when placed on the finish_reason chunk instead (see fixture c). **This is the single most consequential finding**: if OpenRouter delivers usage via the pattern its own docs describe as the norm ("usage is always included in the final chunk"), and that final chunk has empty `choices`, `ChatOpenRouter.stream()` silently reports zero usage and zero cost. |
| **Truncated stream** | Fake server writes a partial, invalid JSON body then destroys the socket. `model.invoke()` rejects with `TypeError: terminated` (`err.cause` is undici's `SocketError: other side closed`, `code: "UND_ERR_SOCKET"`). Never resolves with a partial message. | Fake server sends 3 of 6 fixture SSE chunks then destroys the socket (no `[DONE]`). The adapter yields exactly those 3 complete `AIMessageChunk`s (partial content recoverable by the caller if consumed inside a `try`), then the async generator throws the identical `TypeError: terminated` / `SocketError: other side closed`. |
| **Mid-stream error** (in-band `error` field, HTTP 200 preserved) | Non-streaming analog: OpenRouter's standard error envelope (`{"error":{"code","message"}}`, non-2xx status). `model.invoke()` throws a typed, package-exported `OpenRouterError` with `.statusCode` (`502`), `.code` (`"server_error"`), `.message` (`"Provider disconnected unexpectedly"`) all correctly populated. Full fidelity for this path. | **Does not throw.** `_streamResponseChunks` never reads `data.error` at all; it builds a normal (empty-content) chunk from `choices[0].delta` and merges `finish_reason:"error"` into `response_metadata` the same as any other finish reason. `response_metadata.finish_reason === "error"` is the *only* surfaced signal; `error.code`/`error.message` are silently dropped — absent from `additional_kwargs`, `response_metadata`, everywhere (`JSON.stringify()` of the message contains neither string). A caller relying on exceptions to detect stream failure will not see one here. |

### Test names (fixture → test file → test)

- (a) Tool call: `test/tool-call.test.ts` — "tool call: invoke surfaces
  the parsed tool call, raw tool call, and usage_metadata"; "tool call:
  stream assembles tool_call_chunks by index into the same final tool
  call".
- (b) Citations: `test/citations.test.ts` — "citations: invoke preserves
  Unicode content but drops annotations entirely"; "citations: stream
  preserves Unicode content but drops annotations entirely"; "citations:
  raw-response access path (monkey-patched global fetch) recovers
  annotations the adapter drops"; "citations: offsets are codepoint-based,
  not UTF-16 code-unit-based -- naive JS .slice() misreads the citation".
- (c) Usage (finish_reason-chunk placement): `test/usage.test.ts` —
  "usage: invoke normalizes reasoning/cached tokens into usage_metadata;
  cost and cache-write only survive on response_metadata.usage"; "usage:
  stream normalizes the same fields when usage rides on the finish_reason
  chunk".
- (d) Usage-only final chunk: `test/usage-only-chunk.test.ts` —
  "usage-only-chunk: server actually sends the documented empty-choices
  trailing chunk"; "usage-only-chunk: invoke surfaces usage normally (no
  trailing-chunk concept in a single JSON response)"; "usage-only-chunk:
  stream DROPS the usage-only trailing chunk entirely -- no
  usage_metadata, no response_metadata.usage".
- (e) Truncated stream: `test/truncated-stream.test.ts` — "truncated
  stream: yields exactly the chunks sent before the drop, then throws
  TypeError('terminated')"; "truncated stream (invoke mode): a JSON body
  cut off mid-response also throws TypeError('terminated'), never
  resolves".
- (f) Mid-stream error: `test/mid-stream-error.test.ts` — "mid-stream
  error (stream mode): does NOT throw; finish_reason surfaces as 'error'
  but the error payload is silently dropped"; "mid-stream error (invoke
  mode): a non-streaming HTTP error envelope throws a typed
  OpenRouterError"; "mid-stream error: maxRetries makes the caller retry
  N+1 times against a persistently-failing invoke".
- Server sanity (fixture/mode-agnostic): `test/server.test.ts` (5 tests —
  JSON serving + request recording minus `authorization`, SSE serving
  with `[DONE]`, SSE truncation, unknown-model 404, non-streaming error
  envelope).

`npm run typecheck` (`tsc -p tsconfig.json --noEmit`) passes with no
errors against `typescript@7.0.2`.

## Real-provider evidence (observed, or "none executed")

None executed. No real OpenRouter API key exists in this environment and
this workspace never calls a real provider (`experiments/README.md`).
The controlled real selected-model smoke test (tool calling, streaming,
usage reporting through the actual chosen model, once one is selected —
open decision D7) is deferred to **M7** per
`docs/integration-feasibility.md` ("Follow with a controlled real
selected-model smoke test before research acceptance") and
`docs/agent-execution.md` ("Verify tool calling, streaming, and usage
reporting for the selected model through the LangChain integration").

## Observed limitations

- **Default retry behavior is slow and multiplies requests.** With
  `maxRetries` left at its `ChatOpenRouter` default, a persistently-failing
  `invoke()` against the mid-stream-error fixture's non-streaming (502)
  analog retried **6 additional times** (7 total requests observed by the
  fake server) over **~93–105s** (two separate runs: `93200ms` via
  `scripts/verify-default-retry.ts`, `105264ms` via an earlier ad hoc
  check) before finally throwing `OpenRouterError`. All fixture tests in
  this package pass `maxRetries: 0` (or a small value, to demonstrate the
  general "N+1 requests" mechanic quickly in
  `test/mid-stream-error.test.ts`) specifically to avoid this cost; a
  real caller that does not configure `maxRetries` will wait roughly this
  long before surfacing a persistent provider error, and will send this
  many requests, which is a real cost/latency consideration for M7/M8's
  actual integration, not just this test suite.
- **This adapter's retry wrapper does not cover mid-stream failures.**
  The `this.caller.callWithOptions(...)` retry wrapper in both `_generate`
  and `_streamResponseChunks` only wraps the initial `fetch` +
  status-check; once a 200 response begins streaming (or a non-streaming
  body begins arriving), a later failure (truncation, in-band error) is
  outside the retry wrapper and is never retried, regardless of
  `maxRetries`. Confirmed via `server.requests.length === 1` in the
  truncated-stream and mid-stream-error (stream-mode) tests.
  `TypeError: terminated` (undici's own error, not an
  `@langchain/openrouter`-specific class) and a silently-swallowed in-band
  `error` chunk are two different failure shapes a caller must handle
  separately from `OpenRouterError`.
- **The Unicode-citation-offset convention is a constructed assumption,
  not a verified fact.** OpenRouter's web-search docs do not state
  whether `start_index`/`end_index` are UTF-16 code-unit offsets or
  Unicode codepoint offsets. This experiment picked codepoint offsets
  specifically to exercise the mismatch a non-JS backend would likely
  produce; the finding that annotations are dropped by the adapter
  (verified) is independent of which convention is correct, but the
  specific "naive slice is off by one" demonstration depends on this
  assumption and needs revisiting once a real annotated response is
  observed (M7).
- **The raw-response access path (monkey-patched `globalThis.fetch`) is
  global and process-wide**, not scoped to one `ChatOpenRouter` instance —
  it would need careful lifecycle management (install/restore) in any
  real integration, and would not work at all inside an environment that
  freezes or restricts `globalThis` reassignment. It was exercised only
  for `invoke`'s single JSON response in the committed tests; the same
  `response.clone()` approach applies to the SSE body in principle but
  was not separately re-verified here.
- **`FakeOpenRouterServer`'s truncation needed a fix to be realistic.**
  An initial implementation called `res.socket.destroy()` synchronously
  right after `res.write()`, which sometimes destroyed the connection
  before any bytes reached the client (observed: `bytesRead: 0` on the
  client socket). Fixed by destroying inside the `write()` completion
  callback plus a `setImmediate` turn, after which truncation reliably
  delivers the intended partial data before the connection drops. Noted
  in case a similar fixture server is built elsewhere in this workspace.
- Per `experiments/README.md`, this experiment does not select object
  storage, hosting, a native model, or an OpenCode provider/model.

## Outstanding checks and owning milestone

- Real selected-model smoke test (tool calling, streaming, usage
  reporting, web search) against an actual OpenRouter model once one is
  chosen — **M7** (`docs/agent-execution.md`, "Initial native model
  provider"; `docs/integration-feasibility.md`, S4).
- Whether a real OpenRouter response ever delivers `annotations` on
  streaming deltas incrementally (this experiment attaches the full
  annotations array to a single delta, a constructed choice) or only on
  the final content delta / final message — **M7**.
- Whether real OpenRouter streaming responses use the empty-choices
  usage-only trailing chunk pattern in practice for the model(s) actually
  selected, which determines whether the "usage-only final chunk" finding
  above is a live production risk or a theoretical one — **M7**, feeding
  into **M9** usage-accounting reconciliation
  (`docs/usage-accounting.md`).
- Whether `search-cost` / search-specific cost breakdown (mentioned in
  `docs/integration-feasibility.md`'s "OpenRouter accounting" row) is
  present in `cost_details` for a real web-search-enabled response — not
  covered by any fixture here (no live `plugins: [{id:"web"}]` cost
  fields were documented on the usage-accounting page as reviewed) —
  **M7/M9**.
- A persisted, application-level reconciliation of `response_metadata.usage`
  (raw, complete) versus `usage_metadata` (normalized, missing cost and
  cache-write) into ticketIt's usage/cost totals — **M9**
  (`docs/usage-accounting.md`), since this experiment only shows where
  the data is, not how the application should read it.
- Configuring/tuning `maxRetries` and related caller behavior for the
  real integration (this experiment only records the *default*, unset
  behavior as observed) — **M7/M8**.

## Decision impacts (open-decision IDs)

- **D7 (native model unselected)**: this experiment exercises the
  adapter mechanism only (fake server, constructed fixtures); it selects
  no OpenRouter model and makes no claim about which model to use. It
  does inform D7 by establishing, ahead of model selection, that
  `ChatOpenRouter@0.4.13`'s fidelity gaps (dropped citations, dropped
  cost/cache-write from `usage_metadata`, and the usage-only-chunk
  streaming drop) are adapter-version properties independent of which
  model is eventually selected, and would apply to any model chosen
  under D7 unless the adapter changes.
- **Usage accounting rules for M9**
  (`docs/usage-accounting.md`): confirms that `usage_metadata` alone is
  an incomplete source for ticketIt's cost totals — `cost` and
  `cache_write_tokens` require reading `response_metadata.usage`
  (invoke) or risk being entirely absent (stream, if OpenRouter uses the
  empty-choices trailing-chunk delivery pattern). M9's reconciliation
  design should read `response_metadata.usage` (or an equivalent raw
  passthrough) rather than relying on `usage_metadata` alone, and should
  treat streaming usage as potentially "unknown, not zero" (per
  `docs/usage-accounting.md`'s existing framing) until the empty-choices
  question above is resolved against a real model in M7.
