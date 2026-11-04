import { describe, expect, test } from "bun:test";
import { localAgentSmokeMode } from "./windows-smoke-mode.js";

describe("packaged local-agent smoke capability mode", () => {
  test("defaults to real execution on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] satisfies NodeJS.Platform[]) {
      expect(localAgentSmokeMode({ platform, release: "10.0.20348", requested: undefined })).toBe("supported");
    }
  });

  test("allows only an explicitly selected older Windows host", () => {
    for (const release of ["10.0.20348", "10.0.26099"]) {
      expect(localAgentSmokeMode({ platform: "win32", release, requested: "unavailable-windows" })).toBe("unavailable-windows");
    }
    for (const release of ["10.0.26100", "10.0.26340", "11.0.20348", "invalid", "10.0.20348extra"]) {
      expect(() => localAgentSmokeMode({ platform: "win32", release, requested: "unavailable-windows" })).toThrow();
    }
    for (const platform of ["darwin", "linux"] satisfies NodeJS.Platform[]) {
      expect(() => localAgentSmokeMode({ platform, release: "10.0.20348", requested: "unavailable-windows" })).toThrow();
    }
    expect(() => localAgentSmokeMode({ platform: "win32", release: "10.0.20348", requested: "skip" })).toThrow();
  });
});
