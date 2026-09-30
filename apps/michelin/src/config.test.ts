import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

const TOKEN = `tir_${"a".repeat(43)}`;
const base = { MICHELIN_RUNNER_TOKEN: TOKEN };

describe("loadConfig", () => {
  it("defaults to Galley's dev address and 10 second intervals", () => {
    const config = loadConfig(base);
    expect(config.galleyUrl.href).toBe("http://localhost:8080/");
    expect(config.statusIntervalMs).toBe(10_000);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.runnerCredential.authorizationHeader()).toBe(`Bearer ${TOKEN}`);
  });

  it("reads every variable", () => {
    const config = loadConfig({
      ...base,
      GALLEY_URL: "https://galley.example.test:9000/base",
      MICHELIN_STATUS_INTERVAL_MS: "250",
      MICHELIN_HEARTBEAT_INTERVAL_MS: "500",
    });
    expect(config.galleyUrl.href).toBe("https://galley.example.test:9000/base/");
    expect(config.statusIntervalMs).toBe(250);
    expect(config.heartbeatIntervalMs).toBe(500);
  });

  it.each(["not a url", "", "ftp://localhost:8080", "localhost:8080"])("rejects GALLEY_URL %j", (value) => {
    expect(() => loadConfig({ ...base, GALLEY_URL: value })).toThrow(ConfigError);
  });

  it.each(["MICHELIN_STATUS_INTERVAL_MS", "MICHELIN_HEARTBEAT_INTERVAL_MS"])("rejects bad %s values", (name) => {
    for (const value of ["0", "-5", "1.5", "abc", "", "1e3", " 10"]) {
      expect(() => loadConfig({ ...base, [name]: value })).toThrow(ConfigError);
    }
  });

  it("requires MICHELIN_RUNNER_TOKEN", () => {
    expect(() => loadConfig({})).toThrow(/MICHELIN_RUNNER_TOKEN is required/);
  });

  it("reports every problem at once", () => {
    try {
      loadConfig({ GALLEY_URL: "nope", MICHELIN_STATUS_INTERVAL_MS: "0", MICHELIN_HEARTBEAT_INTERVAL_MS: "x" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toHaveLength(4);
    }
  });
});
