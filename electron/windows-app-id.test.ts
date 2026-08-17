import { expect, test } from "bun:test";

import { resolveWindowsAppUserModelId } from "./windows-app-id";

test("matches the Squirrel package and executable identity", () => {
  expect(resolveWindowsAppUserModelId("prod")).toBe("com.squirrel.ardor.Ardor");
  expect(resolveWindowsAppUserModelId("stage1")).toBe("com.squirrel.ardor-dev.Ardor Dev");
});
