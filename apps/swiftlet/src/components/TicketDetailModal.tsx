import { useLayoutEffect, useRef } from "react";
import { openTicketFullPage } from "../router";
import { isPlainLinkClick } from "./Link";
import { TicketDetailPage } from "./TicketDetailPage";

interface TicketDetailModalProps {
  ticketId: string;
  onClose: () => void;
  onUnauthenticated: () => void;
  onCommandSucceeded: () => void;
}

export function TicketDetailModal({ ticketId, onClose, onUnauthenticated, onCommandSucceeded }: TicketDetailModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    const overflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-label="Ticket details"
      className="ticket-detail-dialog"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <button type="button" autoFocus onClick={onClose}>Close</button>{" "}
      <a href={`/tickets/${encodeURIComponent(ticketId)}`} onClick={(event) => {
        if (!isPlainLinkClick(event)) return;
        event.preventDefault();
        openTicketFullPage(ticketId);
      }}>Open full page</a>
      <TicketDetailPage ticketId={ticketId} onUnauthenticated={onUnauthenticated} onCommandSucceeded={onCommandSucceeded} presentation="modal" />
    </dialog>
  );
}
