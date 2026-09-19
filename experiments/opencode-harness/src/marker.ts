import { existsSync, readFileSync } from "node:fs";

/** POSIX single-quote a string for safe use as one shell word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A shell command that appends `line` to `markerFilePath`, for scripting
 * into `scriptBashToolCall({ command: markerAppendCommand(...) })`. Used as
 * the side-effect marker: each time the scripted bash tool call actually
 * runs (as opposed to being blocked on a permission wait), it appends one
 * line, so `readMarkerLines` gives an exact count of executions from
 * outside OpenCode, independent of the SDK's own reporting.
 */
export function markerAppendCommand(markerFilePath: string, line = "executed"): string {
  return `echo ${shellQuote(line)} >> ${shellQuote(markerFilePath)}`;
}

/** Read the marker file's non-empty lines, or `[]` if it does not exist yet. */
export function readMarkerLines(markerFilePath: string): string[] {
  if (!existsSync(markerFilePath)) return [];
  return readFileSync(markerFilePath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}
