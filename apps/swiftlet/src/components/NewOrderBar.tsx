import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { TICKET_TITLE_MAX_LENGTH } from "../api/tickets";
import { CaptureModal } from "./CaptureModal";
import { PrimaryButton } from "./ui";

export function NewOrderBar({ onCreated, onUnauthenticated }: { onCreated: () => void; onUnauthenticated: () => void }) {
  const [title, setTitle] = useState("");
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <form
        data-testid="new-order-bar"
        onSubmit={(event) => { event.preventDefault(); setOpen(true); }}
        className="mb-4 flex flex-wrap items-stretch bg-header ring-2 ring-amber"
      >
        <label htmlFor="new-order-input" className="m-0 flex items-center bg-amber px-3 py-2 text-label font-bold tracking-label text-ink uppercase">New order</label>
        <input
          id="new-order-input"
          data-testid="new-order-input"
          value={title}
          maxLength={TICKET_TITLE_MAX_LENGTH}
          placeholder="Title, then Enter"
          autoComplete="off"
          onChange={(event) => setTitle(event.target.value)}
          className="min-w-0 flex-[1_1_10rem] border-0 bg-transparent px-3 py-2 text-body text-paper placeholder:text-dim"
        />
        <Dialog.Trigger asChild>
          <PrimaryButton tone="ground" data-testid="new-order-button" className="max-sm:w-full">Add order</PrimaryButton>
        </Dialog.Trigger>
      </form>
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
