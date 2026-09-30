import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { TICKET_TITLE_MAX_LENGTH } from "../api/tickets";
import { CaptureModal } from "./CaptureModal";
import { OrderBar, OrderBarInput, OrderBarLabel, PrimaryButton } from "./ui";

export function NewOrderBar({ onCreated, onUnauthenticated }: { onCreated: () => void; onUnauthenticated: () => void }) {
  const [title, setTitle] = useState("");
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <OrderBar data-testid="new-order-bar" onSubmit={(event) => { event.preventDefault(); setOpen(true); }}>
        <OrderBarLabel htmlFor="new-order-input">New order</OrderBarLabel>
        <OrderBarInput
          id="new-order-input"
          data-testid="new-order-input"
          value={title}
          maxLength={TICKET_TITLE_MAX_LENGTH}
          placeholder="Title, then Enter"
          autoComplete="off"
          onChange={(event) => setTitle(event.target.value)}
        />
        <Dialog.Trigger asChild>
          <PrimaryButton data-testid="new-order-button" className="max-sm:w-full">Add order</PrimaryButton>
        </Dialog.Trigger>
      </OrderBar>
      {open && (
        <CaptureModal
          initialTitle={title}
          onUnauthenticated={onUnauthenticated}
          onClose={() => setOpen(false)}
          onCreated={() => { setTitle(""); setOpen(false); onCreated(); }}
        />
      )}
    </Dialog.Root>
  );
}
