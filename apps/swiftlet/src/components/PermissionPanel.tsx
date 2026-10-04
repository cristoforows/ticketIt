import { useEffect, useState } from "react";
import { GalleyError } from "../api/http";
import type { RoundAuthorityCheck } from "../api/rounds";
import type { PermissionGrant, PermissionRequest, Ticket } from "../api/tickets";
import { FieldHint, FieldLabel, FieldNote, InlineError, LocalTime, PrimaryButton, ReceiptLine, SecondaryButton } from "./ui";

export type DecidePermission = (roundId: string, requestId: string, decision: "approve" | "decline") => Promise<Ticket>;

const refreshedMessages: Record<string, string> = {
  permission_already_decided: "This Permission request is already decided. The receipt now shows the decision Galley recorded.",
  permission_decision_not_available: "A decision is no longer available on this request. The receipt now shows the Ticket as Galley has it.",
};

export function SubstituteLabel() {
  return (
    <span data-testid="permission-substitute" className="ml-2 border border-ink px-1.5 py-px text-label font-bold tracking-label uppercase">
      Substitute account
    </span>
  );
}

function AccountName({ account, substitute }: { account: string; substitute: boolean }) {
  return (
    <>
      <span className="break-all">{account}</span>
      {substitute && <SubstituteLabel />}
    </>
  );
}

function ScopeLines({ scope, testIdPrefix }: { scope: { account: string; action: string; resource: string; substituteAccount: boolean }; testIdPrefix: string }) {
  return (
    <dl className="m-0 mt-1 flex flex-col gap-1">
      <ReceiptLine label="Account" data-testid={`${testIdPrefix}-account`}><AccountName account={scope.account} substitute={scope.substituteAccount} /></ReceiptLine>
      <ReceiptLine label="Action" data-testid={`${testIdPrefix}-action`}><span className="break-all">{scope.action}</span></ReceiptLine>
      <ReceiptLine label="Resource" data-testid={`${testIdPrefix}-resource`}><span className="break-all">{scope.resource}</span></ReceiptLine>
    </dl>
  );
}

export function PermissionPanel({ roundId, request, availability, onDecide, onDecided }: {
  roundId: string;
  request: PermissionRequest;
  availability: Ticket["allowedActions"]["permissionDecision"];
  onDecide?: DecidePermission;
  onDecided: (ticket: Ticket) => void;
}) {
  const [sending, setSending] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [request.id]);

  async function decide(decision: "approve" | "decline") {
    if (!onDecide || sending) return;
    setSending(decision);
    setError(null);
    try {
      onDecided(await onDecide(roundId, request.id, decision));
    } catch (failure) {
      setError(failure instanceof GalleyError && refreshedMessages[failure.code] ? refreshedMessages[failure.code] : failure instanceof Error ? failure.message : "Unable to send the decision.");
    } finally {
      setSending(null);
    }
  }

  return (
    <section aria-label="Permission request" data-testid="ticket-detail-permission" data-request-id={request.id} className="my-3 border-2 border-ink p-3">
      <FieldLabel as="h4">Permission request</FieldLabel>
      <p className="my-1">The Agent asks to act on a Connected Account. Galley denied it and the Round waits for your decision.</p>
      <ScopeLines scope={request} testIdPrefix="ticket-detail-permission" />
      <FieldHint>Requested <LocalTime iso={request.requestedAt} /></FieldHint>
      {request.decision === "approved" ? (
        <p data-testid="ticket-detail-permission-approved" className="my-1 font-bold">Allowed for this Ticket. The Round resumes.</p>
      ) : request.decision === "declined" ? (
        <p data-testid="ticket-detail-permission-declined" className="my-1">
          <span className="font-bold">Declined.</span> The Round still waits for a Permission; Stop ends it.
        </p>
      ) : availability.available ? (
        <div data-testid="ticket-detail-permission-actions" className="mt-2 flex flex-wrap gap-2">
          <PrimaryButton data-testid="ticket-detail-permission-approve" disabled={sending !== null || !onDecide} onClick={() => void decide("approve")}>
            {sending === "approve" ? "Allowing…" : "Allow for this Ticket"}
          </PrimaryButton>
          <SecondaryButton data-testid="ticket-detail-permission-decline" disabled={sending !== null || !onDecide} onClick={() => void decide("decline")}>
            {sending === "decline" ? "Declining…" : "Decline"}
          </SecondaryButton>
        </div>
      ) : (
        <FieldNote data-testid="ticket-detail-permission-unavailable">{availability.reason?.message}</FieldNote>
      )}
      {request.decision === null && availability.available && (
        <FieldHint>Allowing grants this Agent this one action on this one resource, for this Ticket only.</FieldHint>
      )}
      {error && <InlineError data-testid="ticket-detail-permission-error">{error}</InlineError>}
    </section>
  );
}

function decisionText(request: PermissionRequest, awaiting: boolean): string {
  switch (request.decision) {
    case "approved":
      return "Allowed for this Ticket";
    case "declined":
      return "Declined";
    default:
      return awaiting ? "Awaiting your decision" : "Not decided";
  }
}

function scopeText(scope: { account: string; action: string; resource: string }): string {
  return `${scope.action} on ${scope.resource} (${scope.account})`;
}

export function PermissionHistory({ requests, checks, checkCount, awaiting }: { requests: PermissionRequest[]; checks: RoundAuthorityCheck[]; checkCount: number; awaiting: boolean }) {
  if (requests.length === 0 && checkCount === 0) return null;
  return (
    <>
      {requests.length > 0 && (
        <section aria-label="Permission requests" data-testid="ticket-detail-round-permission-requests" className="mt-3">
          <FieldLabel as="h4">Permission requests</FieldLabel>
          <ol className="my-1 flex list-none flex-col gap-2 p-0">
            {requests.map((request) => (
              <li key={request.id} data-testid="ticket-detail-round-permission-request" data-request-id={request.id} data-decision={request.decision ?? "pending"} className="mt-0 border-t-0 pt-0">
                <p className="m-0 break-words">
                  {scopeText(request)}
                  {request.substituteAccount && <SubstituteLabel />}
                </p>
                <p className="m-0 text-muted">
                  Requested <LocalTime iso={request.requestedAt} /> · {decisionText(request, awaiting)}
                  {request.decidedAt !== null && <> <LocalTime iso={request.decidedAt} /></>}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
      {checkCount > 0 && (
        <section aria-label="Authority checks" data-testid="ticket-detail-round-authority-checks" className="mt-3">
          <FieldLabel as="h4">Authority checks</FieldLabel>
          {checkCount > checks.length && (
            <FieldNote data-testid="ticket-detail-round-authority-checks-truncated">Showing the latest {checks.length} of {checkCount} checks.</FieldNote>
          )}
          <ol className="my-1 flex list-none flex-col gap-1 p-0">
            {checks.map((check, index) => (
              <li key={`${check.checkedAt}-${index}`} data-testid="ticket-detail-round-authority-check" data-decision={check.decision} className="mt-0 flex items-baseline gap-3 border-t-0 pt-0">
                <LocalTime iso={check.checkedAt} className="shrink-0 text-label text-muted" />
                <span className="min-w-0 break-words">
                  <span className="font-bold uppercase">{check.decision === "allow" ? "Allowed" : "Denied"}</span> {scopeText(check)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

export function PermissionGrants({ grants }: { grants: PermissionGrant[] }) {
  if (grants.length === 0) return null;
  return (
    <section aria-label="Permissions for this Ticket" data-testid="ticket-detail-permission-grants" className="my-3">
      <FieldLabel as="h4">Permissions for this Ticket</FieldLabel>
      <ol className="my-1 flex list-none flex-col gap-2 p-0">
        {grants.map((grant) => (
          <li key={grant.id} data-testid="ticket-detail-permission-grant" data-grant-id={grant.id} className="mt-0 border-t-0 pt-0">
            <p className="m-0 break-words">
              {grant.agent.name} may {scopeText(grant)}
              {grant.substituteAccount && <SubstituteLabel />}
            </p>
            <p className="m-0 text-muted">Allowed for this Ticket <LocalTime iso={grant.approvedAt} /></p>
          </li>
        ))}
      </ol>
    </section>
  );
}
