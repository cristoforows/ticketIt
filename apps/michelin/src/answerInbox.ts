export interface ReceivedAnswer {
  text: string;
  acknowledge(): Promise<void>;
}

export interface ReceivedApproval {
  grantId: string;
  acknowledge(): Promise<void>;
}

export type Await<T> = (id: string, signal: AbortSignal) => Promise<T | undefined>;

export type AwaitAnswer = Await<ReceivedAnswer>;

export type AwaitApproval = Await<ReceivedApproval>;

export class Inbox<T> {
  readonly #held = new Map<string, T>();
  readonly #waiters = new Map<string, (item: T) => void>();

  deliver(id: string, item: T): void {
    const waiter = this.#waiters.get(id);
    if (waiter !== undefined) {
      this.#waiters.delete(id);
      waiter(item);
      return;
    }
    if (!this.#held.has(id)) {
      this.#held.set(id, item);
    }
  }

  readonly wait: Await<T> = (id, signal) => {
    const held = this.#held.get(id);
    if (held !== undefined) {
      this.#held.delete(id);
      return Promise.resolve(held);
    }
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      const onAbort = (): void => {
        this.#waiters.delete(id);
        resolve(undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.set(id, (item) => {
        signal.removeEventListener("abort", onAbort);
        resolve(item);
      });
    });
  };
}

export class AnswerInbox extends Inbox<ReceivedAnswer> {}

export class ApprovalInbox extends Inbox<ReceivedApproval> {}
