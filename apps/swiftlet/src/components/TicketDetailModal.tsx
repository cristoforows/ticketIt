import * as Dialog from "@radix-ui/react-dialog";
import { collectionPath, openTicketFullPage, ticketDetailPath, type CollectionRoute } from "../router";
import { isPlainLinkClick } from "./Link";
import { capsLinkClasses, ReceiptDialog, SecondaryButton } from "./ui";
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
      <ReceiptDialog
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (window.location.pathname === collectionPath(background)) focusTicketRow(background, ticketId);
        }}
      >
        <Dialog.Title className="sr-only">Ticket details</Dialog.Title>
        <div className="mb-4 flex items-center justify-between gap-3">
          <Dialog.Close asChild><SecondaryButton size="sm" autoFocus>Close</SecondaryButton></Dialog.Close>
          <a className={capsLinkClasses()} href={ticketDetailPath(ticketId, background)} onClick={(event) => {
            if (!isPlainLinkClick(event)) return;
            event.preventDefault();
            openTicketFullPage(ticketId);
          }}>Open full page</a>
        </div>
        <TicketDetailPage ticketId={ticketId} onUnauthenticated={onUnauthenticated} onCommandSucceeded={onCommandSucceeded} onArchiveSucceeded={onClose} presentation="modal" />
      </ReceiptDialog>
    </Dialog.Root>
  );
}
