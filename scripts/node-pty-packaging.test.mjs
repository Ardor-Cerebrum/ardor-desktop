import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const unixTerminal = readFileSync(
  new URL("../node_modules/node-pty/lib/unixTerminal.js", import.meta.url),
  "utf8",
);

test("node-pty does not rewrite an already unpacked ASAR path", () => {
  assert.match(
    unixTerminal,
    /helperPath\.includes\('app\.asar\.unpacked'\)[\s\S]*helperPath\.replace\('app\.asar', 'app\.asar\.unpacked'\)/,
  );
  assert.match(
    unixTerminal,
    /helperPath\.includes\('node_modules\.asar\.unpacked'\)[\s\S]*helperPath\.replace\('node_modules\.asar', 'node_modules\.asar\.unpacked'\)/,
  );
});
