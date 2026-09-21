import type { Page } from "@playwright/test";

export interface Ticket {
  id: number;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Creates a Ticket through Galley's own API -- never by writing to
 * PostgreSQL directly (ADR 0001) -- using the signed-in page's own
 * session: `page.request` shares cookie storage and `baseURL` with
 * `page`'s browser context, so this reaches Galley exactly as the
 * signed-in browser would, with no separate sign-in of its own.
 *
 * This is the data-setup convention issue #56 establishes (see
 * README.md, "Adding a spec"): a spec that needs Tickets to already
 * exist as background data -- not as the behavior under test -- calls
 * this rather than driving the capture form itself or reaching into
 * the database. A spec that *is* testing the capture form (like
 * tests/ticket-persistence-before.spec.ts) still drives that form
 * directly instead of calling this.
 */
export async function createTicket(page: Page, title: string): Promise<Ticket> {
  const response = await page.request.post("/api/tickets", { data: { title } });
  if (!response.ok()) {
    throw new Error(
      `failed to create Ticket ${JSON.stringify(title)} via POST /api/tickets: ${response.status()} ${await response.text()}`,
    );
  }
  return response.json();
}
