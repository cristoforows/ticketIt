import * as Dialog from "@radix-ui/react-dialog";
import { collectionPath, openTicketFullPage, ticketDetailPath, type CollectionRoute } from "../router";
import { isPlainLinkClick } from "./Link";
import { SecondaryButton } from "./ui";
import { TicketDetailPage } from "./TicketDetailPage";
import { focusTicketRow } from "./TicketModalLink";

interface TicketDetailModalProps {
  ticketId: string;
  background: CollectionRoute;
  onClose: () => void;
  onUnauthenticated: () => void;
  onCommandSucceeded: () => void;
}

export function TicketDetailModal({ ticketId, background, onClose, onUnauthenticated, onCommandSucceeded }: TicketDetailModalProps) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (window.location.pathname === collectionPath(background)) focusTicketRow(background, ticketId);
          }}
          className="fixed top-1/2 left-1/2 z-50 box-border w-[min(var(--size-receipt),calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto bg-paper p-5 text-ink shadow-paper"
        >
          <Dialog.Title className="sr-only">Ticket details</Dialog.Title>
          <div className="mb-4 flex items-center justify-between gap-3">
            <Dialog.Close asChild><SecondaryButton size="sm" autoFocus>Close</SecondaryButton></Dialog.Close>
            <a className="text-label font-bold tracking-label uppercase" href={ticketDetailPath(ticketId, background)} onClick={(event) => {
              if (!isPlainLinkClick(event)) return;
              event.preventDefault();
              openTicketFullPage(ticketId);
            }}>Open full page</a>
          </div>
          <TicketDetailPage ticketId={ticketId} onUnauthenticated={onUnauthenticated} onCommandSucceeded={onCommandSucceeded} onArchiveSucceeded={onClose} presentation="modal" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
