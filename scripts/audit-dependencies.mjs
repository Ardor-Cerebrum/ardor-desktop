import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AUDIT_REVIEW_DATE = "2026-09-14";

const APPROVED_ADVISORY = "https://github.com/advisories/GHSA-jmr9-qjv8-65gv";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateAuditReport(report, now = new Date()) {
  invariant(now instanceof Date && !Number.isNaN(now.valueOf()), "Invalid audit validation date");
  invariant(
    now.toISOString().slice(0, 10) < AUDIT_REVIEW_DATE,
    `The extract-zip exception expired on ${AUDIT_REVIEW_DATE}; review upstream before extending it`,
  );
  invariant(report && typeof report === "object" && !Array.isArray(report), "Audit output must be an object");

  const packageNames = Object.keys(report);
  invariant(
    packageNames.length === 1 && packageNames[0] === "extract-zip",
    "The dependency audit finding set changed; review the exception",
  );
  const advisories = report["extract-zip"];
  invariant(Array.isArray(advisories) && advisories.length === 1, "Unexpected extract-zip advisory set");
  invariant(advisories[0]?.url === APPROVED_ADVISORY, "Unapproved extract-zip advisory");
}

export function validateDependencyBoundary(packageJson, lockfile) {
  invariant(packageJson && typeof packageJson === "object", "package.json must be an object");
  invariant(typeof lockfile === "string", "bun.lock must be text");
  invariant(packageJson.devDependencies?.["@electron-forge/cli"], "Electron Forge must remain a dev dependency");
  invariant(!packageJson.dependencies?.["@electron-forge/cli"], "Electron Forge must not be a runtime dependency");
  invariant(
    !packageJson.dependencies?.["extract-zip"] && !packageJson.devDependencies?.["extract-zip"],
    "extract-zip must remain transitive",
  );
  invariant(
    /"@electron\/packager": \["@electron\/packager@18\.4\.4"/.test(lockfile),
    "Electron Packager version changed; review the exception",
  );
  invariant(/"extract-zip": \["extract-zip@2\.0\.1"/.test(lockfile), "extract-zip version changed");

  const extractZipReferences = [...lockfile.matchAll(/"extract-zip": "([^"]+)"/g)].map((match) => match[1]);
  invariant(
    JSON.stringify(extractZipReferences) === JSON.stringify(["^2.0.0", "cli.js"]),
    "extract-zip dependency path changed; review the exception",
  );
}

function runAudit() {
  const result = spawnSync(process.execPath, ["audit", "--json"], {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  invariant(result.status === 0 || result.status === 1, `bun audit failed: ${result.stderr.trim()}`);

  const output = result.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const jsonStart = output.indexOf("{");
  invariant(jsonStart >= 0, "bun audit did not return JSON findings");
  return JSON.parse(output.slice(jsonStart));
}

export async function main({ now = new Date() } = {}) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const [packageText, lockfile] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8"),
    readFile(resolve(root, "bun.lock"), "utf8"),
  ]);
  validateAuditReport(runAudit(), now);
  validateDependencyBoundary(JSON.parse(packageText), lockfile);
  console.log(`Dependency audit passed with one build-only exception; review before ${AUDIT_REVIEW_DATE}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Dependency audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}
