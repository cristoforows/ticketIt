import { buttonClasses, Paper, Rule } from "./ui";

/**
 * The signed-out application state: a single action that starts
 * Galley's own GitHub OAuth flow. This is a real navigation (an anchor,
 * not a fetch) — Swiftlet holds no OAuth secret and performs no token
 * exchange itself; it only ever sends the browser to Galley's endpoint
 * and later reads back the session that results from GET /api/session.
 */
export function SignInPage() {
  return (
    <Paper data-testid="sign-in-page" className="mx-auto w-full max-w-(--size-narrow) p-6">
      <h2 className="text-center text-body font-bold tracking-label uppercase">Sign in</h2>
      <p className="text-center text-muted">Sign in to continue.</p>
      <Rule />
      <a data-testid="sign-in-with-github" href="/api/auth/github/start" className={buttonClasses({ className: "w-full" })}>
        Sign in with GitHub
      </a>
    </Paper>
  );
}
