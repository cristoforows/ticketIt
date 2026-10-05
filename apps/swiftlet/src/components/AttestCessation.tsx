import * as Dialog from "@radix-ui/react-dialog";
import { useId, useRef, useState } from "react";
import type { AttestationBasis, AttestCessationRequest, RoundAttestation } from "../api/rounds";
import type { Ticket } from "../api/tickets";
import { FieldHint, FieldLabel, InlineError, LocalTime, PrimaryButton, ReceiptBody, ReceiptDialog, ReceiptFooter, ReceiptTitle, Rule, SecondaryButton, Textarea } from "./ui";

export type AttestCessation = (roundId: string, body: AttestCessationRequest) => Promise<Ticket>;

export const ATTESTATION_NOTE_MAX_LENGTH = 1000;

export const ATTEST_CESSATION_COPY =
  "ticketIt cannot tell whether this Round is still running. Confirm only after making sure it has stopped, for example by ending the Michelin process or switching off its machine. If it is still running, its work continues outside ticketIt. The Round will end as Interrupted and the Ticket will move to Blocked. Nothing already done is undone.";

export const attestationBasisLabels: Record<AttestationBasis, string> = {
  runner_process_ended: "I ended the Michelin process",
  runner_host_off: "The machine running Michelin is off",
  other: "Other",
};

const BASES: AttestationBasis[] = ["runner_process_ended", "runner_host_off", "other"];

export function AttestCessationControl({ roundId, availability, onAttest, onAttested }: {
  roundId: string;
  availability: Ticket["allowedActions"]["attestCessation"];
  onAttest?: AttestCessation;
  onAttested: (ticket: Ticket) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!availability.available && error === null) return null;
  return (
    <section aria-label="Attest that execution has ceased" data-testid="ticket-detail-attest" className="my-3">
      {availability.available && (
        <Dialog.Root open={open} onOpenChange={(next) => { if (next) setError(null); setOpen(next); }}>
          <Dialog.Trigger asChild>
            <SecondaryButton data-testid="ticket-detail-attest-open" disabled={!onAttest}>Attest that execution has ceased</SecondaryButton>
          </Dialog.Trigger>
          {open && onAttest && <AttestCessationDialog roundId={roundId} onAttest={onAttest} onAttested={onAttested} onFailed={setError} onClose={() => setOpen(false)} />}
        </Dialog.Root>
      )}
      {error && <InlineError data-testid="ticket-detail-attest-error" className="mt-2">{error}</InlineError>}
    </section>
  );
}

function AttestCessationDialog({ roundId, onAttest, onAttested, onFailed, onClose }: {
  roundId: string;
  onAttest: AttestCessation;
  onAttested: (ticket: Ticket) => void;
  onFailed: (message: string) => void;
  onClose: () => void;
}) {
  const ids = useId();
  const [basis, setBasis] = useState<AttestationBasis | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const keepWaiting = useRef<HTMLButtonElement>(null);
  const keepOpenWhilePending = (event: Event) => {
    if (pending) event.preventDefault();
  };
  const noteBlank = note.trim() === "";
  const ready = basis !== null && !(basis === "other" && noteBlank);

  async function attest() {
    if (pending || basis === null || !ready) return;
    setPending(true);
    try {
      onAttested(await onAttest(roundId, noteBlank ? { basis } : { basis, note }));
    } catch (failure) {
      onFailed(failure instanceof Error ? failure.message : "Unable to record the attestation.");
    }
    onClose();
  }

  return (
    <ReceiptDialog
      data-testid="ticket-detail-attest-dialog"
      layout="stack"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        keepWaiting.current?.focus();
      }}
      onEscapeKeyDown={keepOpenWhilePending}
      onInteractOutside={keepOpenWhilePending}
    >
      <ReceiptBody>
        <ReceiptTitle as={Dialog.Title}>Attest that execution has ceased</ReceiptTitle>
        <Rule className="my-0" weight="thick" />
        <Dialog.Description data-testid="ticket-detail-attest-copy" className="m-0">{ATTEST_CESSATION_COPY}</Dialog.Description>
        <fieldset data-testid="ticket-detail-attest-basis" className="m-0 border-0 p-0" disabled={pending}>
          <legend className="m-0 p-0 text-label font-bold tracking-label text-muted uppercase">How you know it stopped</legend>
          {BASES.map((value) => (
            <label key={value} className="mt-1 flex items-center gap-2">
              <input type="radio" name={`${ids}-basis`} value={value} className="accent-ink" checked={basis === value} onChange={() => setBasis(value)} data-testid={`ticket-detail-attest-basis-${value}`} />
              {attestationBasisLabels[value]}
            </label>
          ))}
        </fieldset>
        <div>
          <FieldLabel htmlFor={`${ids}-note`}>{basis === "other" ? "Note (required)" : "Note (optional)"}</FieldLabel>
          <FieldHint id={`${ids}-note-hint`}>Up to {ATTESTATION_NOTE_MAX_LENGTH} characters. It stays on the Round.</FieldHint>
          <Textarea
            id={`${ids}-note`}
            data-testid="ticket-detail-attest-note"
            value={note}
            maxLength={ATTESTATION_NOTE_MAX_LENGTH}
            required={basis === "other"}
            aria-describedby={`${ids}-note-hint`}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </ReceiptBody>
      <ReceiptFooter>
        <div className="flex flex-wrap gap-2">
          <PrimaryButton data-testid="ticket-detail-attest-confirm" disabled={pending || !ready} onClick={() => void attest()}>
            {pending ? "Recording…" : "Attest that execution has ceased"}
          </PrimaryButton>
          <Dialog.Close asChild>
            <SecondaryButton ref={keepWaiting} data-testid="ticket-detail-attest-cancel" disabled={pending}>
              Keep waiting
            </SecondaryButton>
          </Dialog.Close>
        </div>
      </ReceiptFooter>
    </ReceiptDialog>
  );
}

export function AttestationRecord({ attestation }: { attestation: RoundAttestation }) {
  return (
    <section aria-label="Ended by your attestation" data-testid="ticket-detail-round-attestation" className="mt-3">
      <FieldLabel as="h4">Ended by your attestation</FieldLabel>
      <p data-testid="ticket-detail-round-attestation-basis" className="my-1">{attestationBasisLabels[attestation.basis]}</p>
      {attestation.note !== null && <p data-testid="ticket-detail-round-attestation-note" className="my-1 break-words whitespace-pre-wrap">{attestation.note}</p>}
      <FieldHint data-testid="ticket-detail-round-attestation-at">Attested <LocalTime iso={attestation.attestedAt} /></FieldHint>
    </section>
  );
}
