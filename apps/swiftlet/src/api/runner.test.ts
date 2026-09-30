import { describe, expect, it } from "vitest";
import { isRunnerHealth, lastSeenLabel } from "./runner";

const CONNECTED = {
  state: "connected",
  checkedAt: "2026-10-01T12:00:10Z",
  pairedAt: "2026-10-01T11:00:00Z",
  registeredAt: "2026-10-01T11:00:05Z",
  lastSeenAt: "2026-10-01T12:00:05Z",
  michelinVersion: "0.1.0",
  hostname: "runner-host",
};

describe("lastSeenLabel", () => {
  it.each([
    [null, "never connected"],
    ["2026-10-01T12:00:10Z", "last seen 0 s ago"],
    ["2026-10-01T11:59:31Z", "last seen 39 s ago"],
    ["2026-10-01T11:58:10Z", "last seen 2 min ago"],
    ["2026-10-01T09:00:10Z", "last seen 3 h ago"],
    ["2026-09-28T12:00:10Z", "last seen 3 days ago"],
    ["2026-10-01T12:00:20Z", "last seen 0 s ago"],
  ])("measures %s against Galley's checkedAt", (lastSeenAt, label) => {
    expect(lastSeenLabel({ lastSeenAt, checkedAt: "2026-10-01T12:00:10Z" })).toBe(label);
  });
});

describe("isRunnerHealth", () => {
  it("accepts every state Galley can return", () => {
    expect(isRunnerHealth(CONNECTED)).toBe(true);
    expect(isRunnerHealth({ ...CONNECTED, state: "disconnected" })).toBe(true);
    expect(isRunnerHealth({ state: "not_paired", checkedAt: CONNECTED.checkedAt, pairedAt: null, registeredAt: null, lastSeenAt: null, michelinVersion: null, hostname: null })).toBe(true);
  });

  it.each([
    ["unknown state", { ...CONNECTED, state: "online" }],
    ["missing checkedAt", { ...CONNECTED, checkedAt: undefined }],
    ["bad lastSeenAt", { ...CONNECTED, lastSeenAt: "yesterday" }],
    ["numeric hostname", { ...CONNECTED, hostname: 7 }],
    ["missing field", { state: "not_paired", checkedAt: CONNECTED.checkedAt }],
  ])("rejects %s", (_name, value) => {
    expect(isRunnerHealth(value)).toBe(false);
  });
});
