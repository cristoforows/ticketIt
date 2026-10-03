export interface ReceivedAnswer {
  text: string;
  acknowledge(): Promise<void>;
}

export type AwaitAnswer = (questionId: string, signal: AbortSignal) => Promise<ReceivedAnswer | undefined>;

export class AnswerInbox {
  readonly #answers = new Map<string, ReceivedAnswer>();
  readonly #waiters = new Map<string, (answer: ReceivedAnswer) => void>();

  deliver(questionId: string, answer: ReceivedAnswer): void {
    const waiter = this.#waiters.get(questionId);
    if (waiter !== undefined) {
      this.#waiters.delete(questionId);
      waiter(answer);
      return;
    }
    if (!this.#answers.has(questionId)) {
      this.#answers.set(questionId, answer);
    }
  }

  readonly wait: AwaitAnswer = (questionId, signal) => {
    const held = this.#answers.get(questionId);
    if (held !== undefined) {
      this.#answers.delete(questionId);
      return Promise.resolve(held);
    }
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      const onAbort = (): void => {
        this.#waiters.delete(questionId);
        resolve(undefined);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#waiters.set(questionId, (answer) => {
        signal.removeEventListener("abort", onAbort);
        resolve(answer);
      });
    });
  };
}
