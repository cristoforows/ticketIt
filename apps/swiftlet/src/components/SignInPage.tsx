/**
 * The signed-out application state: a single action that starts
 * Galley's own GitHub OAuth flow. This is a real navigation (an anchor,
 * not a fetch) — Swiftlet holds no OAuth secret and performs no token
 * exchange itself; it only ever sends the browser to Galley's endpoint
 * and later reads back the session that results from GET /api/session.
 */
export function SignInPage() {
  return (
    <div data-testid="sign-in-page">
      <p>Sign in to continue.</p>
      <a data-testid="sign-in-with-github" href="/api/auth/github/start">
        Sign in with GitHub
      </a>
    </div>
  );
}
