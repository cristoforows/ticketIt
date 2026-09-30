import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("defaults to Galley's dev address and a 10 second interval", () => {
    const config = loadConfig({});
    expect(config.galleyUrl.href).toBe("http://localhost:8080/");
    expect(config.statusIntervalMs).toBe(10_000);
  });

  it("reads both variables", () => {
    const config = loadConfig({ GALLEY_URL: "https://galley.example.test:9000/base", MICHELIN_STATUS_INTERVAL_MS: "250" });
    expect(config.galleyUrl.href).toBe("https://galley.example.test:9000/base/");
    expect(config.statusIntervalMs).toBe(250);
  });

  it.each(["not a url", "", "ftp://localhost:8080", "localhost:8080"])("rejects GALLEY_URL %j", (value) => {
    expect(() => loadConfig({ GALLEY_URL: value })).toThrow(ConfigError);
  });

  it.each(["0", "-5", "1.5", "abc", "", "1e3", " 10"])("rejects MICHELIN_STATUS_INTERVAL_MS %j", (value) => {
    expect(() => loadConfig({ MICHELIN_STATUS_INTERVAL_MS: value })).toThrow(ConfigError);
  });

  it("reports every problem at once", () => {
    try {
      loadConfig({ GALLEY_URL: "nope", MICHELIN_STATUS_INTERVAL_MS: "0" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toHaveLength(2);
    }
  });
});
