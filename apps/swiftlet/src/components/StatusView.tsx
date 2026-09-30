import { useEffect, useState } from "react";
import { ErrorMessage, LoadingMessage } from "./ui";
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
    return <LoadingMessage data-testid="status-loading">Loading status from Galley…</LoadingMessage>;
  }

  if (state.kind === "error") {
    return (
      <ErrorMessage title="Unable to load status from Galley." data-testid="status-error">
        <p data-testid="status-error-message">{state.message}</p>
      </ErrorMessage>
    );
  }

  const { application, status, version, environment, startedAt } = state.data;
  const rows: Array<[string, string, string]> = [
    ["Application", "status-application", application],
    ["Status", "status-status", status],
    ["Version", "status-version", version],
    ["Environment", "status-environment", environment],
    ["Started at", "status-started-at", startedAt],
  ];

  return (
    <dl data-testid="status-success" className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
      {rows.map(([label, testId, value]) => (
        <div key={testId} className="col-span-2 grid grid-cols-subgrid border-b border-dashed border-rule py-1">
          <dt className="text-label tracking-label text-muted uppercase">{label}</dt>
          <dd data-testid={testId} className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
