import { useEffect, useId, useState } from "react";
import { GalleyError } from "../api/http";
import type { RoundAuthorityCheck } from "../api/rounds";
import type { GrantChoice, PermissionGrant, PermissionRequest, Ticket } from "../api/tickets";
import { ExpiredTag, FieldHint, FieldLabel, FieldNote, InlineError, LocalTime, PrimaryButton, ReceiptLine, SecondaryButton, Select, localTimestamp } from "./ui";

export type DecidePermission = (roundId: string, requestId: string, decision: "approve" | "decline", grant?: GrantChoice) => Promise<Ticket>;

const refreshedMessages: Record<string, string> = {
  permission_already_decided: "This Permission request is already decided. The receipt now shows the decision Galley recorded.",
  permission_decision_not_available: "A decision is no longer available on this request. The receipt now shows the Ticket as Galley has it.",
  invalid_grant_expiry: "Galley refused this expiry: by Galley's clock it must be in the future and at most 30 days away. Choose another duration.",
  grant_form_conflict: "Galley refused a grant both for this Ticket and with an expiry. Choose one form.",
};

// Galley's limit is 30 days from its own clock; the longest choice stays well inside it whatever this browser's clock says.
export const GRANT_DURATIONS: readonly { seconds: number; label: string }[] = [
  { seconds: 3_600, label: "1 hour" },
  { seconds: 8 * 3_600, label: "8 hours" },
  { seconds: 86_400, label: "1 day" },
  { seconds: 7 * 86_400, label: "7 days" },
];

export function grantExpiry(seconds: number, nowMs: number): string {
  return new Date(nowMs + seconds * 1000).toISOString();
}

export function remainingText(seconds: number): string {
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h left` : `${hours} h ${minutes % 60} min left`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d left` : `${days} d ${hours % 24} h left`;
}

function grantedText(grant: PermissionGrant | undefined): string {
  switch (grant?.form) {
    case "ticket":
      return "Allowed for this Ticket";
    case "time":
      return "Allowed for a time";
    default:
      return "Allowed";
  }
}

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

export function PermissionPanel({ roundId, request, availability, onDecide, onDecided, grants = [] }: {
  roundId: string;
  request: PermissionRequest;
  availability: Ticket["allowedActions"]["permissionDecision"];
  onDecide?: DecidePermission;
  onDecided: (ticket: Ticket) => void;
  grants?: PermissionGrant[];
}) {
  const [sending, setSending] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<"ticket" | "time">("ticket");
  const [duration, setDuration] = useState(GRANT_DURATIONS[0]!.seconds);
  const ids = useId();

  useEffect(() => {
    setError(null);
    setForm("ticket");
    setDuration(GRANT_DURATIONS[0]!.seconds);
  }, [request.id]);

  async function decide(decision: "approve" | "decline") {
    if (!onDecide || sending) return;
    setSending(decision);
    setError(null);
    const grant: GrantChoice = form === "ticket" ? { form: "ticket" } : { form: "time", expiresAt: grantExpiry(duration, Date.now()) };
    try {
      onDecided(await (decision === "approve" ? onDecide(roundId, request.id, decision, grant) : onDecide(roundId, request.id, decision)));
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
      {request.renewsGrantId !== null && (
        <p data-testid="ticket-detail-permission-renewal" className="my-1">
          <span className="font-bold">Renewal.</span> The Agent's time-based grant for this scope expired.
        </p>
      )}
      <FieldHint>Requested <LocalTime iso={request.requestedAt} /></FieldHint>
      {request.decision === "approved" ? (
        <p data-testid="ticket-detail-permission-approved" className="my-1 font-bold">{grantedText(grants.find((grant) => grant.id === request.grantId))}. The Round resumes.</p>
      ) : request.decision === "declined" ? (
        <p data-testid="ticket-detail-permission-declined" className="my-1">
          <span className="font-bold">Declined.</span> The Round still waits for a Permission; Stop ends it.
        </p>
      ) : availability.available ? (
        <>
        <fieldset data-testid="ticket-detail-permission-form" className="m-0 mt-2 border-0 p-0" disabled={sending !== null || !onDecide}>
          <legend className="m-0 p-0 text-label font-bold tracking-label text-muted uppercase">Allow</legend>
          <label className="mt-1 flex items-baseline gap-2">
            <input type="radio" name={`${ids}-form`} value="ticket" className="accent-ink" checked={form === "ticket"} onChange={() => setForm("ticket")} data-testid="ticket-detail-permission-form-ticket" />
            <span>For this Ticket <span className="text-muted">— this action on this resource, on this Ticket only</span></span>
          </label>
          <label className="mt-1 flex items-baseline gap-2">
            <input type="radio" name={`${ids}-form`} value="time" className="accent-ink" checked={form === "time"} onChange={() => setForm("time")} data-testid="ticket-detail-permission-form-time" />
            <span>For a time <span className="text-muted">— this action on this resource, on any of this Agent's Tickets, until it expires</span></span>
          </label>
          {form === "time" && (
            <div className="mt-2 ml-6">
              <FieldLabel htmlFor={`${ids}-duration`}>Expires after</FieldLabel>
              <Select id={`${ids}-duration`} data-testid="ticket-detail-permission-duration" className="w-auto" aria-describedby={`${ids}-expiry`} value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                {GRANT_DURATIONS.map((choice) => <option key={choice.seconds} value={choice.seconds}>{choice.label}</option>)}
              </Select>
              <FieldHint id={`${ids}-expiry`} data-testid="ticket-detail-permission-expiry">Until about {localTimestamp(grantExpiry(duration, Date.now()))}, by Galley's clock when you allow it.</FieldHint>
            </div>
          )}
        </fieldset>
        <div data-testid="ticket-detail-permission-actions" className="mt-2 flex flex-wrap gap-2">
          <PrimaryButton data-testid="ticket-detail-permission-approve" disabled={sending !== null || !onDecide} onClick={() => void decide("approve")}>
            {sending === "approve" ? "Allowing…" : form === "ticket" ? "Allow for this Ticket" : "Allow for a time"}
          </PrimaryButton>
          <SecondaryButton data-testid="ticket-detail-permission-decline" disabled={sending !== null || !onDecide} onClick={() => void decide("decline")}>
            {sending === "decline" ? "Declining…" : "Decline"}
          </SecondaryButton>
        </div>
        </>
      ) : (
        <FieldNote data-testid="ticket-detail-permission-unavailable">{availability.reason?.message}</FieldNote>
      )}
      {request.decision === null && availability.available && (
        <FieldHint>Allowing grants this Agent this one action on this one resource and nothing else.</FieldHint>
      )}
      {error && <InlineError data-testid="ticket-detail-permission-error">{error}</InlineError>}
    </section>
  );
}

function decisionText(request: PermissionRequest, awaiting: boolean, grants: PermissionGrant[]): string {
  switch (request.decision) {
    case "approved":
      return grantedText(grants.find((grant) => grant.id === request.grantId));
    case "declined":
      return "Declined";
    default:
      return awaiting ? "Awaiting your decision" : "Not decided";
  }
}

function scopeText(scope: { account: string; action: string; resource: string }): string {
  return `${scope.action} on ${scope.resource} (${scope.account})`;
}

export function PermissionHistory({ requests, checks, checkCount, awaiting, grants = [] }: { requests: PermissionRequest[]; checks: RoundAuthorityCheck[]; checkCount: number; awaiting: boolean; grants?: PermissionGrant[] }) {
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
                  Requested <LocalTime iso={request.requestedAt} />{request.renewsGrantId !== null && " · Renews an expired grant"} · {decisionText(request, awaiting, grants)}
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
                  {check.expiredGrantId !== null && <span data-testid="ticket-detail-round-authority-check-expired" className="text-muted"> · its time-based grant expired</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

function GrantTerms({ grant }: { grant: PermissionGrant }) {
  if (grant.form === "ticket" || grant.expiresAt === null || grant.remainingSeconds === null) {
    return <p className="m-0 text-muted">Allowed for this Ticket <LocalTime iso={grant.approvedAt} /></p>;
  }
  if (grant.state === "expired") {
    return (
      <p className="m-0 text-muted">
        <ExpiredTag data-testid="ticket-detail-permission-grant-expired">Expired</ExpiredTag> Allowed for a time <LocalTime iso={grant.approvedAt} /> · expired <LocalTime iso={grant.expiresAt} />
      </p>
    );
  }
  return (
    <p className="m-0 text-muted">
      Allowed for a time <LocalTime iso={grant.approvedAt} /> · until <LocalTime iso={grant.expiresAt} /> ·{" "}
      <span data-testid="ticket-detail-permission-grant-remaining">{remainingText(grant.remainingSeconds)}</span>
    </p>
  );
}

export function PermissionGrants({ grants, count = grants.length }: { grants: PermissionGrant[]; count?: number }) {
  if (grants.length === 0) return null;
  return (
    <section aria-label="Permissions for this Ticket" data-testid="ticket-detail-permission-grants" className="my-3">
      <FieldLabel as="h4">Permissions for this Ticket</FieldLabel>
      {count > grants.length && (
        <FieldNote data-testid="ticket-detail-permission-grants-truncated">Showing the latest {grants.length} of {count} grants.</FieldNote>
      )}
      <ol className="my-1 flex list-none flex-col gap-2 p-0">
        {grants.map((grant) => (
          <li key={grant.id} data-testid="ticket-detail-permission-grant" data-grant-id={grant.id} data-form={grant.form} data-state={grant.state} className="mt-0 border-t-0 pt-0">
            <p className="m-0 break-words">
              {grant.agent.name} may {scopeText(grant)}
              {grant.substituteAccount && <SubstituteLabel />}
            </p>
            <GrantTerms grant={grant} />
          </li>
        ))}
      </ol>
    </section>
  );
}
