// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { localTimestamp, shortDate } from "./time";

describe("local time", () => {
  const suiteZone = process.env.TZ;
  afterEach(() => { process.env.TZ = suiteZone; });

  it.each([
    ["Asia/Kolkata", "2026-09-22T23:59:00Z", "23 Sep 2026 05:29:00 UTC+05:30", "23 Sep"],
    ["America/Los_Angeles", "2026-09-22T03:04:05Z", "21 Sep 2026 20:04:05 UTC-07:00", "21 Sep"],
    ["America/Los_Angeles", "2026-12-01T03:04:05Z", "30 Nov 2026 19:04:05 UTC-08:00", "30 Nov"],
    ["UTC", "2026-10-03T14:05:09.123Z", "03 Oct 2026 14:05:09 UTC+00:00", "03 Oct"],
    ["Pacific/Chatham", "2026-01-01T00:00:00Z", "01 Jan 2026 13:45:00 UTC+13:45", "01 Jan"],
  ])("renders in %s the viewer's wall clock and offset", (zone, iso, timestamp, date) => {
    process.env.TZ = zone;
    expect(localTimestamp(iso)).toBe(timestamp);
    expect(shortDate(iso)).toBe(date);
  });

  it("runs the suite outside UTC", () => {
    expect(suiteZone).toBe("Asia/Kolkata");
    expect(new Date("2026-10-01T00:00:00Z").getTimezoneOffset()).toBe(-330);
  });
});
