import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import { UnauthenticatedError } from "../api/session";
import { createTicket, TICKET_TEMPLATES, TICKET_TITLE_MAX_LENGTH, type Ticket, type TicketDetails } from "../api/tickets";
import { refinementGuidance } from "./refinementGuidance";
import { ErrorMessage, FieldHint, FieldLabel, PrimaryButton, ReceiptBody, ReceiptDialog, ReceiptFooter, ReceiptTitle, Rule, SecondaryButton, Select, TextInput, Textarea } from "./ui";

interface CaptureModalProps {
  initialTitle: string;
  onCreated: () => void;
  onUnauthenticated: () => void;
  onClose: () => void;
}

const detailFields = [
  { key: "goal", label: "Goal", testId: "goal" },
  { key: "context", label: "Context", testId: "context" },
  { key: "successCriteria", label: "Success Criteria", testId: "success-criteria" },
  { key: "constraints", label: "Constraints", testId: "constraints" },
] as const;

export function CaptureModal({ initialTitle, onCreated, onUnauthenticated, onClose }: CaptureModalProps) {
  const [title, setTitle] = useState(initialTitle);
  const [template, setTemplate] = useState<Ticket["template"]>("Basic");
  const [details, setDetails] = useState<TicketDetails>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleInput = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await createTicket(title, template, details);
      onCreated();
    } catch (cause) {
      setPending(false);
      if (cause instanceof UnauthenticatedError) {
        onUnauthenticated();
        return;
      }
      setError(cause instanceof Error ? cause.message : "Failed to capture the ticket.");
    }
  }

  const keepOpenWhilePending = (event: Event) => {
    if (pending) event.preventDefault();
  };

  return (
    <ReceiptDialog
      layout="stack"
      aria-describedby={undefined}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        const input = titleInput.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }}
      onEscapeKeyDown={keepOpenWhilePending}
      onInteractOutside={keepOpenWhilePending}
    >
      <form data-testid="ticket-capture-form" onSubmit={handleSubmit} className="my-0 flex min-h-0 flex-col">
        <ReceiptBody data-testid="ticket-capture-body">
          <ReceiptTitle as={Dialog.Title}>New order</ReceiptTitle>
          <Rule className="my-0" weight="thick" />
          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <div>
              <FieldLabel htmlFor="ticket-title-input">Title</FieldLabel>
              <TextInput
                ref={titleInput}
                id="ticket-title-input"
                data-testid="ticket-title-input"
                value={title}
                maxLength={TICKET_TITLE_MAX_LENGTH}
                onChange={(event) => setTitle(event.target.value)}
                disabled={pending}
                aria-required="true"
                className="mt-1"
              />
            </div>
            <div>
              <FieldLabel htmlFor="ticket-template-select">Template</FieldLabel>
              <Select
                id="ticket-template-select"
                data-testid="ticket-template-select"
                value={template}
                onChange={(event) => setTemplate(event.target.value as Ticket["template"])}
                disabled={pending}
                className="mt-1"
              >
                {TICKET_TEMPLATES.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </Select>
            </div>
          </div>
          {detailFields.map(({ key, label, testId }) => (
            <div key={key}>
              <FieldLabel htmlFor={`ticket-capture-${testId}`}>{label}</FieldLabel>
              <FieldHint data-testid={`ticket-capture-guidance-${testId}`}>{refinementGuidance[key]}</FieldHint>
              <Textarea
                id={`ticket-capture-${testId}`}
                data-testid={`ticket-capture-${testId}`}
                value={details[key] ?? ""}
                onChange={(event) => setDetails((current) => ({ ...current, [key]: event.target.value }))}
                disabled={pending}
                rows={3}
                className="min-h-0"
              />
            </div>
          ))}
          <div>
            <FieldLabel htmlFor="ticket-capture-repository">Repository</FieldLabel>
            <TextInput
              id="ticket-capture-repository"
              data-testid="ticket-capture-repository"
              value={details.repository ?? ""}
              onChange={(event) => setDetails((current) => ({ ...current, repository: event.target.value }))}
              disabled={pending}
              className="mt-1"
            />
          </div>
        </ReceiptBody>
        <ReceiptFooter data-testid="ticket-capture-footer">
          {error && (
            <ErrorMessage title="Could not capture the ticket.">
              <p data-testid="ticket-capture-error" className="m-0">{error}</p>
            </ErrorMessage>
          )}
          <div className="flex gap-2">
            <PrimaryButton type="submit" data-testid="ticket-capture-submit" disabled={pending || title.trim() === ""}>
              Capture
            </PrimaryButton>
            <SecondaryButton data-testid="ticket-capture-cancel" onClick={onClose} disabled={pending}>
              Cancel
            </SecondaryButton>
          </div>
        </ReceiptFooter>
      </form>
    </ReceiptDialog>
  );
}
