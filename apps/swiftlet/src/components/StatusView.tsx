import { useEffect, useState } from "react";
import { fetchGalleyStatus, type GalleyStatus } from "../api/status";

type FetchState =
  | { kind: "loading" }
  | { kind: "success"; data: GalleyStatus }
  | { kind: "error"; message: string };

/**
 * Renders the status Galley reports at GET /api/status. Every value
 * shown comes from that response; there is no local fallback or
 * hardcoded status that could be mistaken for backend data. An
 * unreachable backend or a non-2xx response renders an explicit error
 * state instead.
 */
export function StatusView() {
  const [state, setState] = useState<FetchState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchGalleyStatus()
      .then((data) => {
        if (!cancelled) {
          setState({ kind: "success", data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : "Unknown error contacting Galley.";
          setState({ kind: "error", message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <p role="status" data-testid="status-loading">
        Loading status from Galley…
      </p>
    );
  }

  if (state.kind === "error") {
    return (
      <div role="alert" data-testid="status-error">
        <p>Unable to load status from Galley.</p>
        <p data-testid="status-error-message">{state.message}</p>
      </div>
    );
  }

  const { application, status, version, environment, startedAt } = state.data;

  return (
    <dl data-testid="status-success">
      <dt>Application</dt>
      <dd data-testid="status-application">{application}</dd>

      <dt>Status</dt>
      <dd data-testid="status-status">{status}</dd>

      <dt>Version</dt>
      <dd data-testid="status-version">{version}</dd>

      <dt>Environment</dt>
      <dd data-testid="status-environment">{environment}</dd>

      <dt>Started at</dt>
      <dd data-testid="status-started-at">{startedAt}</dd>
    </dl>
  );
}
