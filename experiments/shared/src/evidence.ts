/**
 * Minimal helper for experiment packages that record M1 evidence.
 *
 * The admission ledger and any structured evidence storage are out of
 * scope for this slice (see docs/implementation-plan.md M4+). This helper
 * only documents where an experiment's evidence record belongs and renders
 * the section headings from the template, so a new experiment cannot
 * accidentally invent a different shape.
 */

/** Relative path (from the repository root) to the M1 evidence template. */
export const EVIDENCE_TEMPLATE_PATH = "docs/evidence/m1/TEMPLATE.md";

/** Relative path (from the repository root) to the M1 evidence index. */
export const EVIDENCE_INDEX_PATH = "docs/evidence/m1/README.md";

/**
 * Section headings every M1 evidence record must contain, in order.
 * Mirrors docs/evidence/m1/TEMPLATE.md exactly.
 */
export const EVIDENCE_SECTIONS = [
  "Purpose",
  "Exact versions",
  "Reproducible commands",
  "Documentation research (unverified)",
  "Fixture/stub evidence (observed)",
  "Real-provider evidence (observed, or \"none executed\")",
  "Observed limitations",
  "Outstanding checks and owning milestone",
  "Decision impacts (open-decision IDs)",
] as const;

export type EvidenceSection = (typeof EVIDENCE_SECTIONS)[number];

/**
 * Render an empty evidence record with the required section headings, for
 * an experiment to fill in by hand. This does not write a file: an
 * experiment's evidence record is its own committed Markdown file under
 * docs/evidence/m1/, named after its tracking issue (e.g.
 * `16-opencode-boot.md`).
 */
export function renderEvidenceSkeleton(title: string): string {
  const body = EVIDENCE_SECTIONS.map((section) => `## ${section}\n\n_TODO_\n`).join("\n");
  return `# ${title}\n\n${body}`;
}
