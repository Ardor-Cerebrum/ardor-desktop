import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCerebrumRequirements } from "./electron-cerebrum-resource.mjs";

const stage = {
  ARDOR_ELECTRON_CHANNEL: "stage1",
  ARDOR_DESKTOP_CEREBRUM_REQUIREMENTS_SOURCE: "workspace-snapshot",
};

test("reads the verified snapshot descriptor when its pathname is replaced", (context) => {
  const root = fs.mkdtempSync(join(tmpdir(), "ardor-snapshot-race-"));
  const path = join(root, ".desktop-cerebrum-requirements.snapshot.json");
  const original = { ...resolveCerebrumRequirements({}), sourceCommit: "a".repeat(40) };
  const replacement = { ...original, sourceCommit: "b".repeat(40) };
  const read = fs.readSync;
  let swapped = false;
  try {
    fs.writeFileSync(path, JSON.stringify(original));
    context.mock.method(fs, "readSync", (...args) => {
      if (!swapped) {
        swapped = true;
        fs.renameSync(path, join(root, "original.json"));
        fs.writeFileSync(path, JSON.stringify(replacement));
      }
      return read(...args);
    });
    syncBuiltinESMExports();
    assert.deepEqual(resolveCerebrumRequirements(stage, root), original);
    assert.equal(swapped, true);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects growth beyond the snapshot bound after metadata validation", (context) => {
  const root = fs.mkdtempSync(join(tmpdir(), "ardor-snapshot-growth-"));
  const path = join(root, ".desktop-cerebrum-requirements.snapshot.json");
  const read = fs.readSync;
  let grown = false;
  try {
    fs.writeFileSync(path, JSON.stringify({ ...resolveCerebrumRequirements({}), sourceCommit: "a".repeat(40) }));
    context.mock.method(fs, "readSync", (...args) => {
      if (!grown) {
        grown = true;
        fs.appendFileSync(path, " ".repeat(65_537));
      }
      return read(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => resolveCerebrumRequirements(stage, root), /bounded regular file/);
    assert.equal(grown, true);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
