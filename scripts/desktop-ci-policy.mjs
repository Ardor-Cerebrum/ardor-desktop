import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const NON_APPLICATION_TYPES = new Set(["chore", "ci", "docs", "style", "test"]);
const CONVENTIONAL_SUBJECT = /^([a-z]+)(?:\(([^()]+)\))?(!)?:\s+\S/;
const MERGE_SUBJECT = /^Merge pull request #[0-9]+\b/;
const BREAKING_FOOTER = /^BREAKING CHANGES?:\s+\S/im;

export function classifyDesktopBuild(subject, body = "", mergeHead) {
  if (mergeHead) {
    return classifyDesktopBuild(mergeHead.subject, mergeHead.body);
  }

  const conventionalSubject = resolveConventionalSubject(subject, body);
  const match = conventionalSubject.match(CONVENTIONAL_SUBJECT);

  if (!match || match[3] === "!" || BREAKING_FOOTER.test(body)) {
    return { buildRequired: true, conventionalSubject };
  }

  return {
    buildRequired: !NON_APPLICATION_TYPES.has(match[1]),
    conventionalSubject,
  };
}

export function resolveConventionalSubject(subject, body = "") {
  if (!MERGE_SUBJECT.test(subject)) {
    return subject;
  }

  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? subject;
}

function readCommit(sha) {
  const options = { encoding: "utf8" };
  return {
    subject: execFileSync("git", ["show", "-s", "--format=%s", sha], options).trim(),
    body: execFileSync("git", ["show", "-s", "--format=%b", sha], options).trim(),
    parents: execFileSync("git", ["show", "-s", "--format=%P", sha], options).trim().split(/\s+/).filter(Boolean),
  };
}

function run() {
  const sha = process.env.HEAD_SHA?.trim();
  if (!sha) {
    throw new Error("HEAD_SHA is required");
  }

  const { subject, body, parents } = readCommit(sha);
  if (!subject) {
    throw new Error("The head commit has no subject; refusing to skip desktop builds");
  }

  const mergeHead = parents.length === 2 ? readCommit(parents[1]) : undefined;
  const classification = classifyDesktopBuild(subject, body, mergeHead);
  console.error(`Commit subject: ${subject}`);
  if (mergeHead) {
    console.error(`Merge head subject: ${mergeHead.subject}`);
  }
  console.error(`Conventional subject: ${classification.conventionalSubject}`);
  process.stdout.write(String(classification.buildRequired));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run();
}
