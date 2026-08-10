import assert from "node:assert/strict";
import test from "node:test";

import {
  validateAuditReport,
  validateDependencyPath,
  validateDmgBoundary,
} from "./audit-dependencies.mjs";

const approvedReport = {
  "image-size": [
    { url: "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr" },
    { url: "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq" },
  ],
};

const expectedWhyOutput = `image-size@0.7.5
  └─ appdmg@0.6.6 (requires ^0.7.4)
     └─ optional electron-installer-dmg@5.0.1 (requires ^0.6.4)
        └─ optional @electron-forge/maker-dmg@7.11.2 (requires ^5.0.1)
           └─ dev @ardor/desktop (requires ^7.11.2)
`;

const packageJson = {
  devDependencies: { "@electron-forge/maker-dmg": "^7.11.2" },
  dependencies: {},
};

const forgeConfig = {
  makers: [{ name: "@electron-forge/maker-dmg", platforms: ["darwin"] }],
};

test("accepts only the current time-bounded DMG build risk", () => {
  assert.doesNotThrow(() => validateAuditReport(approvedReport, new Date("2026-09-09T23:59:59Z")));
  assert.doesNotThrow(() => validateDependencyPath(expectedWhyOutput));
  assert.doesNotThrow(() => validateDmgBoundary(packageJson, forgeConfig));
});

test("rejects an unapproved advisory", () => {
  const report = structuredClone(approvedReport);
  report["image-size"][1].url = "https://github.com/advisories/GHSA-aaaa-bbbb-cccc";
  assert.throws(() => validateAuditReport(report, new Date("2026-08-10T00:00:00Z")), /Unapproved/);
});

test("rejects a stale exception after a finding disappears", () => {
  const report = { "image-size": [approvedReport["image-size"][0]] };
  assert.throws(() => validateAuditReport(report, new Date("2026-08-10T00:00:00Z")), /finding set changed/);
});

test("rejects malformed advisory data", () => {
  const report = structuredClone(approvedReport);
  delete report["image-size"][0].url;
  assert.throws(() => validateAuditReport(report, new Date("2026-08-10T00:00:00Z")), /missing its advisory URL/);
});

test("rejects the exception on and after its review date", () => {
  assert.throws(() => validateAuditReport(approvedReport, new Date("2026-09-10T00:00:00Z")), /expired/);
});

test("rejects a changed or additional image-size dependency path", () => {
  assert.throws(() => validateDependencyPath(`${expectedWhyOutput}dev another-package (requires *)\n`), /path changed/);
});

test("rejects a custom DMG background", () => {
  const config = structuredClone(forgeConfig);
  config.makers[0].config = { background: "assets/background.png" };
  assert.throws(() => validateDmgBoundary(packageJson, config), /custom DMG background/i);
});

test("rejects maker-dmg as a runtime dependency", () => {
  const manifest = structuredClone(packageJson);
  manifest.dependencies["@electron-forge/maker-dmg"] = "^7.11.2";
  assert.throws(() => validateDmgBoundary(manifest, forgeConfig), /runtime dependency/);
});
