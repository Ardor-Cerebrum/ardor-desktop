import { describe, expect, test } from "bun:test";

import { getShellProtocolRegistration } from "./protocol";

describe("Electron shell protocol registration", () => {
  test("uses the executable and entrypoint when running the default app", () => {
    expect(getShellProtocolRegistration("ardor", true, "/usr/bin/electron", "/work/main.cjs")).toEqual({
      protocol: "ardor",
      executablePath: "/usr/bin/electron",
      args: ["/work/main.cjs"],
    });
  });

  test("uses the packaged app registration shape otherwise", () => {
    expect(getShellProtocolRegistration("ardor", false, "/usr/bin/Ardor", undefined)).toEqual({
      protocol: "ardor",
      executablePath: undefined,
      args: undefined,
    });
  });
});
