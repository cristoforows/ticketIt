/**
 * Public API of the OpenCode live admission bridge (M1.9, issue #20).
 *
 * This package is a NEW, independent experiment package (own
 * package.json/lockfile) that depends on `experiments/opencode-harness`
 * and `experiments/shared` only through their published `file:` local
 * dependencies and exported public APIs — it never modifies either
 * package. A follow-up slice (#21) is expected to extend this package
 * with the full action-path coverage matrix, so the bridge itself
 * (`startAdmittedOpenCode`, the plugin it wires in, and the shared
 * env-var contract between them) is exported here for reuse rather than
 * kept private to the test suite.
 */
export {
  ADMISSION_ENV,
  ADMISSION_PLUGIN_URL,
  attachRoundMapping,
  startAdmittedOpenCode,
} from "./admitted-opencode.js";
export type { AdmittedOpenCode, RoundMapping, StartAdmittedOpenCodeOptions } from "./admitted-opencode.js";
