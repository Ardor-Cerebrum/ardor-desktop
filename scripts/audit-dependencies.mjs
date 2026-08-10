import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AUDIT_REVIEW_DATE = "2026-09-10";

const APPROVED_FINDINGS = new Set([
  "image-size:GHSA-5p2g-fcmc-qvqq",
  "image-size:GHSA-w3rx-r6r6-pgpr",
]);

const EXPECTED_DEPENDENCY_PATH = [
  "image-size@0.7.5",
  "appdmg@0.6.6 (requires ^0.7.4)",
  "optional electron-installer-dmg@5.0.1 (requires ^0.6.4)",
  "optional @electron-forge/maker-dmg@7.11.2 (requires ^5.0.1)",
  "dev @ardor/desktop (requires ^7.11.2)",
];

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function advisoryId(url) {
  invariant(typeof url === "string", "Audit finding is missing its advisory URL");
  const match = url.match(/^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/i);
  invariant(match, `Unexpected advisory URL: ${url}`);
  return match[1];
}

export function validateAuditReport(report, now = new Date()) {
  invariant(now instanceof Date && !Number.isNaN(now.valueOf()), "Invalid audit validation date");
  const currentDate = now.toISOString().slice(0, 10);
  invariant(
    currentDate < AUDIT_REVIEW_DATE,
    `The scoped image-size exception expired on ${AUDIT_REVIEW_DATE}; review upstream before extending it`,
  );
  invariant(report && typeof report === "object" && !Array.isArray(report), "Audit output must be a JSON object");

  const findings = [];
  for (const [packageName, advisories] of Object.entries(report)) {
    invariant(Array.isArray(advisories), `Audit findings for ${packageName} must be an array`);
    for (const advisory of advisories) {
      invariant(advisory && typeof advisory === "object", `Malformed audit finding for ${packageName}`);
      findings.push(`${packageName}:${advisoryId(advisory.url)}`);
    }
  }

  invariant(findings.length === APPROVED_FINDINGS.size, "The dependency audit finding set changed; review the exception");
  invariant(new Set(findings).size === findings.length, "The dependency audit contains duplicate findings");
  for (const finding of findings) {
    invariant(APPROVED_FINDINGS.has(finding), `Unapproved dependency audit finding: ${finding}`);
  }
  for (const approvedFinding of APPROVED_FINDINGS) {
    invariant(findings.includes(approvedFinding), `Expected audit finding disappeared: ${approvedFinding}`);
  }
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function validateDependencyPath(output) {
  invariant(typeof output === "string", "bun pm why output must be text");
  const actualPath = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s│├└─]+/u, "").trim())
    .filter(Boolean);

  invariant(
    JSON.stringify(actualPath) === JSON.stringify(EXPECTED_DEPENDENCY_PATH),
    `image-size dependency path changed:\n${actualPath.join("\n")}`,
  );
}

export function validateDmgBoundary(packageJson, forgeConfig) {
  invariant(packageJson && typeof packageJson === "object", "package.json must be an object");
  invariant(
    packageJson.devDependencies?.["@electron-forge/maker-dmg"],
    "@electron-forge/maker-dmg must remain a development-only dependency",
  );
  invariant(
    !packageJson.dependencies?.["@electron-forge/maker-dmg"],
    "@electron-forge/maker-dmg must not become a runtime dependency",
  );

  invariant(Array.isArray(forgeConfig?.makers), "Electron Forge makers must be an array");
  const dmgMakers = forgeConfig.makers.filter((maker) => maker?.name === "@electron-forge/maker-dmg");
  invariant(dmgMakers.length === 1, "Expected exactly one macOS DMG maker");

  const [dmgMaker] = dmgMakers;
  invariant(
    Array.isArray(dmgMaker.platforms) &&
      dmgMaker.platforms.length === 1 &&
      dmgMaker.platforms[0] === "darwin",
    "The DMG maker must remain restricted to darwin",
  );
  invariant(
    dmgMaker.config === undefined ||
      (dmgMaker.config !== null && typeof dmgMaker.config === "object" && !Object.hasOwn(dmgMaker.config, "background")),
    "A custom DMG background would broaden image-size input; review the advisory before adding one",
  );
}

function runBun(args, acceptedStatuses) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  invariant(
    acceptedStatuses.has(result.status),
    `bun ${args.join(" ")} failed with status ${result.status}: ${result.stderr.trim()}`,
  );
  return result.stdout;
}

export async function main({ now = new Date() } = {}) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const auditOutput = runBun(["audit", "--json"], new Set([0, 1]));

  let report;
  try {
    report = JSON.parse(auditOutput);
  } catch (error) {
    throw new Error(`bun audit did not return valid JSON: ${error.message}`);
  }

  const whyOutput = runBun(["pm", "why", "image-size"], new Set([0]));
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const { default: forgeConfig } = await import(pathToFileURL(resolve(root, "electron", "forge.config.mjs")));

  validateAuditReport(report, now);
  validateDependencyPath(whyOutput);
  validateDmgBoundary(packageJson, forgeConfig);

  console.log(
    `Dependency audit passed: only the guarded image-size DMG-build findings remain; review required before ${AUDIT_REVIEW_DATE}.`,
  );
}

const isDirectInvocation = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  main().catch((error) => {
    console.error(`Dependency audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}
