import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";
import { DEFAULT_ENGINE_SCRIPT } from "./engineScript.ts";

const TOKEN = `tir_${"a".repeat(43)}`;
const base = { MICHELIN_RUNNER_TOKEN: TOKEN };

describe("loadConfig", () => {
  it("defaults to Galley's dev address, 10 second status and heartbeat intervals, a 5 second claim interval and a 1 second command interval", () => {
    const config = loadConfig(base);
    expect(config.galleyUrl.href).toBe("http://localhost:8080/");
    expect(config.statusIntervalMs).toBe(10_000);
    expect(config.heartbeatIntervalMs).toBe(10_000);
    expect(config.claimIntervalMs).toBe(5_000);
    expect(config.commandIntervalMs).toBe(1_000);
    expect(config.runnerCredential.authorizationHeader()).toBe(`Bearer ${TOKEN}`);
  });

  it("reads every variable", () => {
    const config = loadConfig({
      ...base,
      GALLEY_URL: "https://galley.example.test:9000/base",
      MICHELIN_STATUS_INTERVAL_MS: "250",
      MICHELIN_HEARTBEAT_INTERVAL_MS: "500",
      MICHELIN_CLAIM_INTERVAL_MS: "750",
      MICHELIN_COMMAND_INTERVAL_MS: "125",
    });
    expect(config.galleyUrl.href).toBe("https://galley.example.test:9000/base/");
    expect(config.statusIntervalMs).toBe(250);
    expect(config.heartbeatIntervalMs).toBe(500);
    expect(config.claimIntervalMs).toBe(750);
    expect(config.commandIntervalMs).toBe(125);
  });

  it.each(["not a url", "", "ftp://localhost:8080", "localhost:8080"])("rejects GALLEY_URL %j", (value) => {
    expect(() => loadConfig({ ...base, GALLEY_URL: value })).toThrow(ConfigError);
  });

  it.each(["MICHELIN_STATUS_INTERVAL_MS", "MICHELIN_HEARTBEAT_INTERVAL_MS", "MICHELIN_CLAIM_INTERVAL_MS", "MICHELIN_COMMAND_INTERVAL_MS"])("rejects bad %s values", (name) => {
    for (const value of ["0", "-5", "1.5", "abc", "", "1e3", " 10"]) {
      expect(() => loadConfig({ ...base, [name]: value })).toThrow(ConfigError);
    }
  });

  it("uses the default engine script when MICHELIN_ENGINE_SCRIPT is unset", () => {
    const config = loadConfig(base, () => {
      throw new Error("no file should be read");
    });
    expect(config.engineScript).toEqual(DEFAULT_ENGINE_SCRIPT);
  });

  it("reads the engine script from the file MICHELIN_ENGINE_SCRIPT names", () => {
    const paths: string[] = [];
    const config = loadConfig({ ...base, MICHELIN_ENGINE_SCRIPT: "/scripts/wait.json" }, (path) => {
      paths.push(path);
      return '{"steps":[{"step":"start"},{"step":"wait","ms":1500},{"step":"hold"}]}';
    });
    expect(paths).toEqual(["/scripts/wait.json"]);
    expect(config.engineScript).toEqual({ steps: [{ step: "start" }, { step: "wait", ms: 1500 }, { step: "hold" }] });
  });

  it("rejects a script file that cannot be read, naming the variable and the reason", () => {
    const missing = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, open '/nope.json'"), { code: "ENOENT" });
    };
    try {
      loadConfig({ ...base, MICHELIN_ENGINE_SCRIPT: "/nope.json" }, missing);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([expect.stringMatching(/^MICHELIN_ENGINE_SCRIPT .*could not be read.*ENOENT/)]);
    }
  });

  it("rejects an invalid script, naming the variable, the file and the step index", () => {
    try {
      loadConfig({ ...base, MICHELIN_ENGINE_SCRIPT: "/scripts/bad.json" }, () => '{"steps":[{"step":"start"},{"step":"wait","ms":0}]}');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([expect.stringMatching(/^MICHELIN_ENGINE_SCRIPT "\/scripts\/bad\.json": steps\[1\]: "ms" must be an integer/)]);
    }
  });

  it("rejects a script whose deliver step is not last", () => {
    const script = JSON.stringify({ steps: [{ step: "start" }, { step: "deliver", bodyMarkdown: "b", summary: "s", criteriaAssessment: "c" }, { step: "hold" }] });
    expect(() => loadConfig({ ...base, MICHELIN_ENGINE_SCRIPT: "s.json" }, () => script)).toThrow(/steps\[1\]: "deliver" may only be the last step/);
  });

  it("rejects an empty MICHELIN_ENGINE_SCRIPT", () => {
    expect(() => loadConfig({ ...base, MICHELIN_ENGINE_SCRIPT: "" }, () => "{}")).toThrow(/MICHELIN_ENGINE_SCRIPT must be the path of a JSON file/);
  });

  it("never echoes the runner token or the script's content in a problem", () => {
    try {
      loadConfig({ ...base, MICHELIN_ENGINE_SCRIPT: "s.json" }, () => `not json ${TOKEN}`);
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).message).not.toContain(TOKEN.slice(4));
    }
  });

  it("requires MICHELIN_RUNNER_TOKEN", () => {
    expect(() => loadConfig({})).toThrow(/MICHELIN_RUNNER_TOKEN is required/);
  });

  it("reports every problem at once", () => {
    try {
      loadConfig({ GALLEY_URL: "nope", MICHELIN_STATUS_INTERVAL_MS: "0", MICHELIN_HEARTBEAT_INTERVAL_MS: "x", MICHELIN_CLAIM_INTERVAL_MS: "-1", MICHELIN_COMMAND_INTERVAL_MS: "0", MICHELIN_ENGINE_SCRIPT: "" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toHaveLength(7);
    }
  });
});
