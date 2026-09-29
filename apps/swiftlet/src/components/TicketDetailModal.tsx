import * as Dialog from "@radix-ui/react-dialog";
import { collectionPath, openTicketFullPage, type CollectionRoute } from "../router";
import { isPlainLinkClick } from "./Link";
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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/55" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (window.location.pathname === collectionPath(background)) focusTicketRow(background, ticketId);
          }}
          className="fixed top-1/2 left-1/2 z-50 box-border w-[min(40rem,calc(100vw-2rem))] max-h-[calc(100vh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border-2 border-solid border-current bg-[Canvas] p-4 text-[CanvasText]"
        >
          <Dialog.Title className="sr-only">Ticket details</Dialog.Title>
          <Dialog.Close asChild><button type="button" autoFocus>Close</button></Dialog.Close>{" "}
          <a href={`/tickets/${encodeURIComponent(ticketId)}`} onClick={(event) => {
            if (!isPlainLinkClick(event)) return;
            event.preventDefault();
            openTicketFullPage(ticketId);
          }}>Open full page</a>
          <TicketDetailPage ticketId={ticketId} onUnauthenticated={onUnauthenticated} onCommandSucceeded={onCommandSucceeded} presentation="modal" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
