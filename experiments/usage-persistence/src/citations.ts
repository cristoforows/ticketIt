/**
 * URL citation annotation handling, codepoint-aware.
 *
 * Per #25's evidence (docs/evidence/m1/25-openrouter-fidelity.md): OpenRouter's
 * web-search docs
 * (https://openrouter.ai/docs/guides/features/plugins/web-search) document
 * `annotations: [{type: "url_citation", url_citation: {url, title, content,
 * start_index, end_index}}]` on the assistant message, but do not state
 * whether `start_index`/`end_index` are UTF-16 code-unit offsets (native JS
 * string indexing) or Unicode codepoint offsets (native Python string
 * indexing). #25's fixture constructs them as codepoint offsets -- a stated
 * assumption, not an observed fact -- specifically to exercise the mismatch:
 * naive JS `content.slice(start, end)` misreads the cited span once a
 * multi-byte/astral character (a UTF-16 surrogate pair) precedes it.
 * `extractCitations` below always recovers the cited text with
 * codepoint-aware slicing (`Array.from(content)`), never naive `.slice()`.
 */

/** One recovered URL citation, with the cited substring resolved codepoint-aware. */
export interface Citation {
  readonly url: string;
  readonly title: string;
  /** OpenRouter's own snippet for the citation ("Added by OpenRouter if available"). */
  readonly content: string;
  readonly startCodepoint: number;
  readonly endCodepoint: number;
  /**
   * The substring of the message content this citation actually points at,
   * recovered via `Array.from(sourceContent).slice(startCodepoint,
   * endCodepoint).join("")` -- NOT `sourceContent.slice(...)`, which is
   * UTF-16-code-unit-based and misreads the span once an astral character
   * precedes it (#25).
   */
  readonly citedText: string;
}

interface RawUrlCitation {
  readonly url?: unknown;
  readonly title?: unknown;
  readonly content?: unknown;
  readonly start_index?: unknown;
  readonly end_index?: unknown;
}

interface RawAnnotation {
  readonly type?: unknown;
  readonly url_citation?: RawUrlCitation;
}

/**
 * Extracts every `url_citation` annotation from a raw OpenRouter
 * `annotations` array (as found on `choices[0].message.annotations` in a raw
 * JSON/SSE response, never on the `ChatOpenRouter`-returned `AIMessage`,
 * which drops this field entirely -- #25), resolving each citation's
 * substring against `sourceContent` with codepoint-aware slicing.
 *
 * Returns an empty array for `undefined`/non-array input, which is exactly
 * what every adapter-surfaced message (`additional_kwargs.annotations`,
 * `response_metadata.annotations`) yields for this adapter version -- see
 * `normalizeFromAdapterMessage` in `usage-ingest.ts`.
 */
export function extractCitations(sourceContent: string, annotations: unknown): Citation[] {
  if (!Array.isArray(annotations)) {
    return [];
  }
  const codepoints = Array.from(sourceContent);
  const citations: Citation[] = [];
  for (const entry of annotations as RawAnnotation[]) {
    if (!entry || entry.type !== "url_citation" || !entry.url_citation) {
      continue;
    }
    const { url, title, content, start_index: startIndex, end_index: endIndex } = entry.url_citation;
    if (typeof url !== "string" || typeof startIndex !== "number" || typeof endIndex !== "number") {
      continue;
    }
    citations.push({
      url,
      title: typeof title === "string" ? title : "",
      content: typeof content === "string" ? content : "",
      startCodepoint: startIndex,
      endCodepoint: endIndex,
      citedText: codepoints.slice(startIndex, endIndex).join(""),
    });
  }
  return citations;
}
