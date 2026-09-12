import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const syncWorkflow = readWorkflow("sync-solutions-ui.yml");
const bundleWorkflow = readWorkflow("bundled-ui.yml");

test("syncs release dispatches through one forward-only pull request", () => {
  const triggers = syncWorkflow.slice(0, syncWorkflow.indexOf("permissions:"));
  const desktopToken = readStep(syncWorkflow, "Create desktop write app token");
  const uiToken = readStep(syncWorkflow, "Create read-only solutions-ui app token");
  const reconcile = readStep(syncWorkflow, "Reconcile verified pin update pull request");

  assert.match(triggers, /repository_dispatch:\s*\n\s+types: \[solutions-ui-released\]/);
  assert.match(triggers, /workflow_dispatch:/);
  assert.match(triggers, /schedule:/);
  assert.match(syncWorkflow, /group: sync-released-solutions-ui/);
  assert.match(syncWorkflow, /cancel-in-progress: false/);
  assert.match(desktopToken, /repositories: ardor-desktop/);
  assert.match(desktopToken, /permission-contents: write/);
  assert.match(desktopToken, /permission-pull-requests: write/);
  assert.match(uiToken, /repositories: solutions-ui/);
  assert.match(uiToken, /permission-contents: read/);
  assert.doesNotMatch(uiToken, /permission-contents: write/);
  assert.match(reconcile, /automation\/solutions-ui-release/);
  assert.match(reconcile, /solutions-ui-pin-policy\.mjs classify/);
  assert.match(reconcile, /solutions-ui-pin-policy\.mjs write/);
  assert.match(reconcile, /pending_base_status/);
  assert.match(reconcile, /gh api --method GET "repos\/\$GITHUB_REPOSITORY\/pulls"/);
  assert.match(reconcile, /head="\$GITHUB_REPOSITORY_OWNER:\$UPDATE_BRANCH"/);
  assert.match(reconcile, /pr_count/);
  assert.match(reconcile, /-f state=closed/);
  assert.match(
    reconcile,
    /--force-with-lease=.*\$remote_head[\s\S]*?:refs\/heads\/\$UPDATE_BRANCH/,
  );
  assert.match(reconcile, /gh pr create/);
  assert.match(reconcile, /gh api --method PATCH/);
  assert.match(reconcile, /-f base=main/);
  assert.doesNotMatch(reconcile, /gh pr merge/);
});

test("validates requested pin data without executing pull-request code", () => {
  const triggers = bundleWorkflow.slice(0, bundleWorkflow.indexOf("permissions:"));
  const checkout = readStep(bundleWorkflow, "Checkout trusted desktop base without credentials");
  const scope = readStep(bundleWorkflow, "Require the generated pin-only pull request");
  const pin = readStep(bundleWorkflow, "Read requested solutions-ui pin as data");
  const uiToken = readStep(bundleWorkflow, "Create read-only solutions-ui app token");
  const release = readStep(bundleWorkflow, "Validate published solutions-ui release");
  const applyPin = readStep(bundleWorkflow, "Apply validated pin to trusted desktop requirements");

  assert.match(triggers, /pull_request_target:/);
  assert.match(scope, /BASE_REPOSITORY: \$\{\{ github\.event\.pull_request\.base\.repo\.full_name \}\}/);
  assert.match(scope, /BASE_BRANCH: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/);
  assert.match(scope, /BASE_BRANCH.*main/);
  assert.match(
    scope,
    /if \[ "\$HEAD_BRANCH" != "automation\/solutions-ui-release" \]; then[\s\S]*?relevant=false/,
  );
  assert.match(checkout, /ref: main/);
  assert.doesNotMatch(checkout, /needs\.scope\.outputs/);
  assert.match(checkout, /persist-credentials: false/);
  assert.doesNotMatch(checkout, /pull_request\.head\.sha/);
  assert.match(pin, /contents\/desktop-ui-requirements\.json\?ref=\$\{PR_HEAD_SHA\}/);
  assert.match(uiToken, /repositories: solutions-ui/);
  assert.match(uiToken, /permission-contents: read/);
  assert.match(release, /commits\/\$\{UI_TAG\}/);
  assert.match(release, /releases\/tags\/\$\{UI_TAG\}/);
  assert.match(release, /compare\/\$\{current_sha\}\.\.\.\$\{UI_SHA\}/);
  assert.match(release, /EVENT_NAME.*workflow_dispatch/);
  assert.match(release, /compare\/\$\{UI_SHA\}\.\.\.main/);
  assert.match(applyPin, /solutions-ui-pin-policy\.mjs write/);
  assert.match(applyPin, /solutions-ui-pin-policy\.mjs verify/);
  assert.match(bundleWorkflow, /verify-desktop-ui-contract\.mjs solutions-ui "\$UI_SHA"/);
  assert.match(bundleWorkflow, /bun run ui:build:prod/);
  assert.match(bundleWorkflow, /ARDOR_SPARKLE_FEED_URL:/);
  assert.match(bundleWorkflow, /ARDOR_SPARKLE_PUBLIC_KEY:/);
  assert.doesNotMatch(bundleWorkflow, /ARDOR_ELECTRON_(FEED_URL|PUBLIC_KEY):/);
});

function readWorkflow(name) {
  return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
}

function readStep(workflow, name) {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end === -1 ? workflow.length : end);
}
