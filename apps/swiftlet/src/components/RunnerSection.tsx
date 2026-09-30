import { useEffect, useRef, useState } from "react";
import { lastSeenLabel, pairRunner, revokeRunner, type RunnerHealth } from "../api/runner";
import { RunnerHealthIndicator, useRunnerHealth } from "./RunnerHealthPill";
import { ErrorMessage, FieldHint, FieldLabel, FieldValue, Paper, PrimaryButton, ReceiptLine, ReceiptTitle, Rule, SecondaryButton, TextInput } from "./ui";

type Confirming = "revoke" | "repair" | null;

interface Issued {
  token: string;
  replacedPrevious: boolean;
}

export function RunnerSection({ onUnauthenticated, onFailed }: { onUnauthenticated: () => void; onFailed: (error: unknown, fallback: string) => string }) {
  const { view, reload } = useRunnerHealth(onUnauthenticated);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const paired = view.kind === "loaded" && view.health.state !== "not_paired";

  async function pair() {
    setError(null);
    setPending(true);
    try {
      const pairing = await pairRunner();
      setIssued({ token: pairing.token, replacedPrevious: paired });
      setRevoked(false);
      setConfirming(null);
    } catch (cause) {
      setError(onFailed(cause, "Failed to pair the runner."));
    } finally {
      setPending(false);
      await reload();
    }
  }

  async function revoke() {
    setError(null);
    setPending(true);
    try {
      await revokeRunner();
      setIssued(null);
      setRevoked(true);
      setConfirming(null);
    } catch (cause) {
      setError(onFailed(cause, "Failed to revoke the runner."));
    } finally {
      setPending(false);
      await reload();
    }
  }

  return (
    <Paper as="section" aria-labelledby="runner-title" data-testid="runner-section" className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReceiptTitle id="runner-title">Runner</ReceiptTitle>
        <RunnerHealthIndicator view={view} tone="paper" live={false} />
      </div>
      <Rule weight="thick" />
      {view.kind === "loaded" && view.health.state !== "not_paired" && <RunnerDetails health={view.health} />}
      {view.kind === "loaded" && view.health.state === "not_paired" && (
        <FieldHint data-testid="runner-not-paired" className="m-0">
          {revoked ? "The runner credential is revoked. Michelin can no longer authenticate." : "No runner is paired. Pair one to let Michelin connect to Galley."}
        </FieldHint>
      )}
      {view.kind === "error" && (
        <ErrorMessage flat title="Unable to load runner health." data-testid="runner-health-error">
          <p className="m-0">Galley did not return the runner's health. It is retried every 10 seconds.</p>
        </ErrorMessage>
      )}
      {issued && <IssuedCredential issued={issued} onDone={() => setIssued(null)} />}
      {confirming ? (
        <ConfirmPanel
          action={confirming}
          pending={pending}
          onConfirm={confirming === "revoke" ? revoke : pair}
          onCancel={() => setConfirming(null)}
        />
      ) : (
        view.kind === "loaded" && (
          <div className="mt-4 flex flex-wrap gap-2">
            {paired ? (
              <>
                <SecondaryButton data-testid="runner-repair-button" onClick={() => setConfirming("repair")} disabled={pending}>Pair again</SecondaryButton>
                <SecondaryButton data-testid="runner-revoke-button" onClick={() => setConfirming("revoke")} disabled={pending}>Revoke</SecondaryButton>
              </>
            ) : (
              <PrimaryButton data-testid="runner-pair-button" onClick={pair} disabled={pending}>Pair runner</PrimaryButton>
            )}
          </div>
        )
      )}
      {error && (
        <ErrorMessage flat title="Runner change failed." className="mt-3">
          <p data-testid="runner-error" className="m-0">{error}</p>
        </ErrorMessage>
      )}
    </Paper>
  );
}

function RunnerDetails({ health }: { health: RunnerHealth }) {
  const rows: Array<[string, string, string]> = [
    ["Paired", "runner-paired-at", health.pairedAt ? new Date(health.pairedAt).toLocaleString() : "—"],
    ["Last seen", "runner-last-seen", health.lastSeenAt ? `${new Date(health.lastSeenAt).toLocaleString()} (${lastSeenLabel(health)})` : "Never connected"],
    ["Michelin", "runner-version", health.michelinVersion ?? "Not registered yet"],
    ["Host", "runner-hostname", health.hostname ?? "Not registered yet"],
  ];
  return (
    <dl className="m-0 grid gap-1">
      {rows.map(([label, testId, value]) => (
        <ReceiptLine key={testId} label={label}>
          <span data-testid={testId} className="break-all">{value}</span>
        </ReceiptLine>
      ))}
    </dl>
  );
}

function ConfirmPanel({ action, pending, onConfirm, onCancel }: { action: "revoke" | "repair"; pending: boolean; onConfirm: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const title = action === "revoke" ? "Revoke the runner credential?" : "Pair a new runner?";
  const detail = action === "revoke"
    ? "Michelin is rejected on its next request. Tickets and their Status do not change."
    : "The current credential is revoked immediately; Michelin needs the new one in its .env.";
  return (
    <div
      role="group"
      aria-labelledby="runner-confirm-title"
      data-testid="runner-confirm"
      onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
      className="mt-4 border-l-4 border-l-status-blocked-deep py-1 pl-4"
    >
      <p id="runner-confirm-title" className="m-0 font-bold">{title}</p>
      <p className="mt-1 mb-3">{detail}</p>
      <div className="flex flex-wrap gap-2">
        <PrimaryButton data-testid="runner-confirm-button" onClick={onConfirm} disabled={pending}>{action === "revoke" ? "Revoke credential" : "Pair new runner"}</PrimaryButton>
        <SecondaryButton ref={cancel} data-testid="runner-cancel-button" onClick={onCancel} disabled={pending}>Cancel</SecondaryButton>
      </div>
    </div>
  );
}

function IssuedCredential({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied("copied");
    } catch {
      input.current?.select();
      setCopied("failed");
    }
  }

  return (
    <div data-testid="runner-credential" className="mt-4 flex flex-col gap-2">
      <FieldLabel htmlFor="runner-credential-input">Runner credential</FieldLabel>
      <div className="flex flex-wrap gap-2">
        <TextInput
          ref={input}
          id="runner-credential-input"
          data-testid="runner-credential-token"
          aria-describedby="runner-credential-hint"
          readOnly
          value={issued.token}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-[1_1_20rem]"
        />
        <PrimaryButton data-testid="runner-copy-button" onClick={copy}>Copy</PrimaryButton>
      </div>
      <FieldHint id="runner-credential-hint" className="m-0">
        Shown once. Put it in Michelin's <code>.env</code> as <code>MICHELIN_RUNNER_TOKEN</code>, make that file readable only by you (<code>chmod 600 .env</code>), then start Michelin.
      </FieldHint>
      {issued.replacedPrevious && <FieldValue data-testid="runner-previous-revoked" className="m-0">The previous credential is revoked.</FieldValue>}
      <p role="status" data-testid="runner-copy-status" className="m-0 text-muted">
        {copied === "copied" ? "Copied." : copied === "failed" ? "Copy failed; the credential is selected, copy it manually." : ""}
      </p>
      <div>
        <SecondaryButton data-testid="runner-credential-done" onClick={onDone}>Done</SecondaryButton>
      </div>
    </div>
  );
}
