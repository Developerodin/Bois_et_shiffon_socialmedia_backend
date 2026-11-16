import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProductionEnv } from "@/server/production-env";

const ok = { NODE_ENV: "production", AUTH_URL: "https://app.example", STORAGE_ACCESS_KEY_ID: "k", STORAGE_SECRET_ACCESS_KEY: "s" };
const withEnv = (env: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries({ ...ok, ...env })) vi.stubEnv(k, v as string);
};

afterEach(() => vi.unstubAllEnvs());

describe("assertProductionEnv (api and worker startup)", () => {
  it("passes a complete production env", () => {
    withEnv({});
    expect(() => assertProductionEnv()).not.toThrow();
  });

  it("refuses an http or missing AUTH_URL", () => {
    withEnv({ AUTH_URL: "http://app.example" });
    expect(() => assertProductionEnv()).toThrow(/https/);
    withEnv({ AUTH_URL: "" });
    expect(() => assertProductionEnv()).toThrow(/https/);
  });

  it("refuses missing storage keys", () => {
    withEnv({ STORAGE_SECRET_ACCESS_KEY: "" });
    expect(() => assertProductionEnv()).toThrow(/STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY/);
  });

  it("checks nothing outside production", () => {
    withEnv({ NODE_ENV: "development", AUTH_URL: "http://localhost:3100", STORAGE_ACCESS_KEY_ID: "" });
    expect(() => assertProductionEnv()).not.toThrow();
  });
});
