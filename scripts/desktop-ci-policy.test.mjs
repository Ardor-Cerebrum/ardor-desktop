import assert from "node:assert/strict";
import test from "node:test";

import { classifyDesktopBuild, resolveConventionalSubject } from "./desktop-ci-policy.mjs";

test("non-application commit types skip desktop package builds", () => {
  for (const type of ["chore", "ci", "docs", "style", "test"]) {
    assert.equal(classifyDesktopBuild(`${type}(ARD-2684): update repository policy`).buildRequired, false);
  }
});

test("application commit types require desktop package builds", () => {
  for (const type of ["build", "feat", "fix", "perf", "refactor", "revert"]) {
    assert.equal(classifyDesktopBuild(`${type}(desktop): update packaged application`).buildRequired, true);
  }
});

test("unknown or malformed commit subjects fail closed", () => {
  assert.equal(classifyDesktopBuild("update desktop").buildRequired, true);
  assert.equal(classifyDesktopBuild("unknown: update desktop").buildRequired, true);
});

test("breaking non-application commits still require desktop package builds", () => {
  assert.equal(classifyDesktopBuild("docs!: replace the runtime contract").buildRequired, true);
  assert.equal(
    classifyDesktopBuild("ci: replace the pipeline", "BREAKING CHANGE: new release contract").buildRequired,
    true,
  );
});

test("main-branch merge commits use the pull request title from the body", () => {
  const subject = "Merge pull request #60 from Ardor-Cerebrum/feature/ard-2684";
  const body = "\ndocs(ARD-2684): standardize coding-agent guidelines\n";

  assert.equal(resolveConventionalSubject(subject, body), body.trim());
  assert.equal(classifyDesktopBuild(subject, body).buildRequired, false);
});

test("the CI-policy merge itself does not require a desktop release", () => {
  const subject = "Merge pull request #62 from Ardor-Cerebrum/codex/ard-2684-non-app-ci-policy";
  const body = "\nci(ARD-2684): skip desktop builds for non-app changes\n";

  assert.equal(classifyDesktopBuild(subject, body).buildRequired, false);
});

test("synthetic merge commits use their pull request head commit", () => {
  const subject = "Merge e70c8f00 into 3aa5694c";
  const mergeHead = {
    subject: "ci(ARD-2684): skip desktop builds for non-app changes",
    body: "",
  };

  assert.equal(classifyDesktopBuild(subject, "", mergeHead).buildRequired, false);
});

test("synthetic application merges still require desktop builds", () => {
  const subject = "Merge application-head into main-head";
  const mergeHead = {
    subject: "fix(desktop): repair application startup",
    body: "",
  };

  assert.equal(classifyDesktopBuild(subject, "", mergeHead).buildRequired, true);
});

test("merge commits without a pull request title fail closed", () => {
  const subject = "Merge pull request #60 from Ardor-Cerebrum/feature/ard-2684";
  assert.equal(classifyDesktopBuild(subject).buildRequired, true);
});
