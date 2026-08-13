import { describe, expect, mock, test } from "bun:test";

import { configureMacOSAutofillPolicy } from "./macos-autofill-policy";

describe("macOS autofill policy", () => {
  test("disables system autofill heuristics on macOS", () => {
    const setUserDefault = mock(() => undefined);

    configureMacOSAutofillPolicy({ setUserDefault }, "darwin");

    expect(setUserDefault).toHaveBeenCalledWith("NSAutoFillHeuristicsEnabled", "boolean", false);
  });

  test("does not write macOS defaults on other platforms", () => {
    const setUserDefault = mock(() => undefined);

    configureMacOSAutofillPolicy({ setUserDefault }, "win32");

    expect(setUserDefault).not.toHaveBeenCalled();
  });
});
