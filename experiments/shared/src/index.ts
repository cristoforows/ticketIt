export { FakeClock } from "./fake-clock.js";
export {
  EVIDENCE_TEMPLATE_PATH,
  EVIDENCE_INDEX_PATH,
  EVIDENCE_SECTIONS,
  renderEvidenceSkeleton,
} from "./evidence.js";
export type { EvidenceSection } from "./evidence.js";
export { AdmissionLedger, assertGrantKind } from "./admission-ledger.js";
export type {
  GrantKind,
  TicketGrantKind,
  TimeGrantKind,
  GrantInput,
  Grant,
  AdmitRequest,
  AdmitDecision,
  AdmitReason,
  AdmitResult,
  AdmissionRecord,
  DispatchRecord,
  LedgerState,
} from "./admission-ledger.js";
export { startLedgerServer } from "./ledger-server.js";
export type { LedgerServerHandle } from "./ledger-server.js";
