import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveVerifiedLocalAgentBundle } from "../electron/local-agent/bundle.js";
import { parseLocalAgentJsonObject, type LocalAgentJsonValue, type LocalAgentRpcMethod } from "../electron/local-agent/protocol.js";
import { LocalAgentRuntimeManager } from "../electron/local-agent/runtime-manager.js";
import { buildLocalAgentArguments, buildLocalAgentEnvironment, buildLocalAgentProviderConfig, createLocalAgentStdioProcess } from "../electron/local-agent/stdio-process.js";

// NOTE(ARD-2319): This is a partial native acceptance harness, not W01-W10
// certification. Never turn the remaining BLOCKED rows into PASS from unit tests.
const { values } = parseArgs({ options: {
  "runtime-root": { type: "string" }, "source-sha": { type: "string" },
  "manifest-sha256": { type: "string" }, "output-dir": { type: "string" },
} });
const output = values["output-dir"] ? resolve(values["output-dir"]) : mkdtempSync(join(tmpdir(), "ardor-mxc-results-"));
mkdirSync(output, { recursive: true });
type Result = { id: string; status: "PASS" | "FAIL" | "BLOCKED" | "KNOWN_LIMITATION"; detail: string; evidence?: LocalAgentJsonValue };
const results: Result[] = [];
const outstanding: Record<string, string> = {
  W01: "Native file create/read/write/save/rename/delete not run.",
  W02: "Native outside write, apply_patch and file RPC checks not run.",
  W03: "Both hardlink directions and policy identity conflicts require full native acceptance (W03a is only one direction).",
  W04: "Win32 plus NtSetInformationFile class 11/72 and workload pre-opened handles require the native helper.",
  W05: "Concurrent link/alias/write race harness and operation counters remain required.",
  W06: "Complete path substitution/ancestor, drive and symlink matrix remains required; W06a/b cover only junction and missing root.",
  W07: "Descendants, stop/crash/logout/exit, background turn and native window lifecycle require installed Desktop.",
  W08: "Approval accept/deny, next-turn expanded access and restart reset require full UI/IPC acceptance.",
  W09: "Direct egress/loopback tests plus independent fixture relay acceptance remain required.",
  W10: "Real unsupported host/capability, mid-command failure and renderer reconnect remain required.",
};
let fixtureRoot: string | undefined;
try {
  if (process.platform !== "win32" || process.arch !== "x64") {
    results.push({ id: "PREFLIGHT", status: "BLOCKED", detail: "Requires prepared Windows x64 with MXC/PSEC; no fallback is attempted." });
  } else {
    await runNative();
  }
} catch (cause) {
  if (!results.some((result) => result.status === "FAIL")) {
    results.push({ id: "PREFLIGHT", status: "BLOCKED", detail: cause instanceof Error ? cause.message : String(cause) });
  }
} finally {
  for (const [id, detail] of Object.entries(outstanding)) {
    if (!results.some((result) => result.id === id)) results.push({ id, status: "BLOCKED", detail });
  }
  writeFileSync(join(output, "matrix.json"), `${JSON.stringify({
    platform: process.platform, arch: process.arch, node: process.version,
    sourceSha: values["source-sha"] ?? null, manifestSha256: values["manifest-sha256"] ?? null,
    fixtureRoot, results,
  }, null, 2)}\n`);
  console.log(`MXC evidence: ${join(output, "matrix.json")}`);
  // Fixture files are deliberately retained for trusted inspection, never
  // recursively cleaned through junctions/hardlinks by the test workload.
  process.exitCode = results.some((result) => result.status === "FAIL") ? 1
    : results.some((result) => result.status === "BLOCKED") ? 2 : 0;
}

async function runNative(): Promise<void> {
  const root = values["runtime-root"];
  const source = values["source-sha"];
  const manifest = values["manifest-sha256"];
  assert.ok(root && source && manifest, "Provide explicit runtime-root, source-sha and manifest-sha256 from the candidate manifest.");
  const bundle = resolveVerifiedLocalAgentBundle(resolve(root), "win32", "x64", source, manifest);
  fixtureRoot = mkdtempSync(join(tmpdir(), "ardor-mxc-fixtures-"));
  const project = join(fixtureRoot, "проект with spaces");
  const outside = join(fixtureRoot, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  const sentinel = join(outside, "protected.txt");
  writeFileSync(sentinel, "outside-seed");
  let modelCalls = 0;
  const listener = createServer((_request, response) => { modelCalls++; response.writeHead(503).end(); });
  await new Promise<void>((resolveListen) => listener.listen(0, "127.0.0.1", resolveListen));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const scope = { accountId: "mxc-test-account", workspaceId: "mxc-test-workspace" };
  const manager = new LocalAgentRuntimeManager({
    channel: "stage1", userDataPath: join(fixtureRoot, "profile"), platform: "win32",
    requestTimeoutMs: 20_000,
    createProcess: ({ runtimeHome }) => {
      writeFileSync(join(runtimeHome, "config.toml"), buildLocalAgentProviderConfig(address.port, "win32"));
      return createLocalAgentStdioProcess({
        command: bundle.executablePath, args: buildLocalAgentArguments(bundle.args, "win32"),
        cwd: runtimeHome, env: buildLocalAgentEnvironment(process.env, runtimeHome, "synthetic-test-relay-token"), platform: "win32",
      });
    },
  });
  try {
    manager.authorizeProjectFolder(scope, project);
    const connection = await manager.connect(scope);
    const started = parseLocalAgentJsonObject(await manager.request(connection.runtimeId, connection.generation, {
      id: "test-thread", method: "thread/start", params: { model: "gpt-5.4", modelProvider: "ardor" },
    }, { cwd: project }));
    const thread = parseLocalAgentJsonObject(started.thread);
    assert.equal(typeof thread.id, "string");
    const context = { cwd: project, threadId: String(thread.id) };
    results.push({ id: "PREFLIGHT", status: "PASS", detail: "Verified bundle; Desktop completed the MXC child probe before thread activation. No model turn started." });
    let id = 0;
    const request = (method: LocalAgentRpcMethod, params: Record<string, LocalAgentJsonValue>) =>
      manager.request(connection.runtimeId, connection.generation, { id: ++id, method, params }, context);
    const command = (argv: string[]) => request("command/exec", { command: argv, timeoutMs: 10_000, outputBytesCap: 4096 });
    const node = (script: string) => command([process.execPath, "-e", script]);
    const marker = `ardor-operation-${randomUUID()}`;
    const attemptWrite = (path: string) => node(`
      const result = { marker: ${JSON.stringify(marker)}, kind: 'write', written: false };
      try { require('node:fs').writeFileSync(${JSON.stringify(path)}, 'UNSAFE'); result.written = true; }
      catch (error) { result.code = error.code; result.syscall = error.syscall; }
      console.log(JSON.stringify(result));
    `);
    const evidence: LocalAgentJsonValue[] = [];
    let negativeAttempt = 0;
    const expectDenied = async (operation: () => Promise<LocalAgentJsonValue>, kind: "write" | "apply-patch" = "write") => {
      let result: Record<string, LocalAgentJsonValue>;
      try {
        result = parseLocalAgentJsonObject(await operation());
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        writeFileSync(join(output, `negative-attempt-${++negativeAttempt}.json`), JSON.stringify({ error }, null, 2));
        throw new Error("Workload did not return operation evidence; an RPC/startup denial cannot prove enforcement.");
      }
      const sentinelAfter = readFileSync(sentinel, "utf8");
      evidence.push({ result, sentinelAfter });
      writeFileSync(join(output, `negative-attempt-${++negativeAttempt}.json`), JSON.stringify({ result, sentinelAfter }, null, 2));
      assert.equal(sentinelAfter, "outside-seed", "outside sentinel changed; STOP ROLLOUT");
      assert.equal(result.exitCode, 0, "operation reporter did not complete");
      assert.equal(typeof result.stdout, "string");
      const report = parseLocalAgentJsonObject(JSON.parse(String(result.stdout).trim()));
      assert.equal(report.marker, marker, "missing operation reporter evidence");
      assert.equal(report.kind, kind);
      if (kind === "write") {
        assert.equal(report.written, false, "operation unexpectedly succeeded");
        assert.ok(report.code === "EACCES" || report.code === "EPERM" || report.code === "EROFS", "expected an OS permission refusal");
        assert.equal(report.syscall, "open");
      } else {
        assert.equal(report.childStarted, true, "apply_patch did not start");
        assert.equal(report.spawnError, null, "apply_patch spawn failed");
        assert.equal(report.exitCode, 1);
        assert.equal(typeof report.stderr, "string");
        assert.ok(String(report.stderr).includes(`Failed to write file ${sentinel}`), "apply_patch must reach the protected file operation");
      }
    };
    await runCase("W01", async () => {
      const result = parseLocalAgentJsonObject(await node(`const fs=require('node:fs');fs.writeFileSync('a.txt','first');fs.writeFileSync('a.txt','saved');if(fs.readFileSync('a.txt','utf8')!=='saved')throw Error('read');fs.renameSync('a.txt','b.txt');fs.unlinkSync('b.txt');console.log('ordinary-write-ok')`));
      assert.equal(result.exitCode, 0);
      assert.equal(String(result.stdout).trim(), "ordinary-write-ok");
      const patch = parseLocalAgentJsonObject(await command([bundle.executablePath, "--codex-run-as-apply-patch",
        "*** Begin Patch\n*** Add File: apply-patch-control.txt\n+inside-ok\n*** End Patch"]));
      assert.equal(patch.exitCode, 0, "inside apply_patch positive control failed");
      assert.equal(readFileSync(join(project, "apply-patch-control.txt"), "utf8").trim(), "inside-ok");
      return { ordinaryWrite: result, applyPatch: patch };
    });
    await runCase("W02", async () => {
      await expectDenied(() => attemptWrite(sentinel));
      const patch = `*** Begin Patch\n*** Update File: ${sentinel}\n@@\n-outside-seed\n+UNSAFE\n*** End Patch`;
      await expectDenied(() => node(`
        const child = require('node:child_process').spawnSync(${JSON.stringify(bundle.executablePath)},
          ['--codex-run-as-apply-patch', ${JSON.stringify(patch)}], { encoding: 'utf8' });
        console.log(JSON.stringify({ marker: ${JSON.stringify(marker)}, kind: 'apply-patch',
          childStarted: child.pid > 0, spawnError: child.error ? child.error.code : null,
          exitCode: child.status, stderr: child.stderr }));
      `), "apply-patch");
      await assert.rejects(request("fs/writeFile", { path: sentinel, dataBase64: Buffer.from("UNSAFE").toString("base64") }), /outside/);
      assert.equal(readFileSync(sentinel, "utf8"), "outside-seed");
      return evidence.splice(0);
    });
    await observePreexistingHardlink({
      sentinel, alias: join(project, "pre-existing-link.txt"), marker, attemptWrite,
    });
    await runCase("W06a", async () => {
      symlinkSync(outside, join(project, "junction"), "junction");
      await expectDenied(() => attemptWrite(join(project, "junction", "protected.txt")));
      return evidence.splice(0);
    });
    await runCase("W06b", async () => {
      const moved = `${project}-moved`;
      renameSync(project, moved);
      try { await assert.rejects(node("throw Error('must not run')")); }
      finally { renameSync(moved, project); }
      return { missingRootRejected: true };
    });
    assert.equal(modelCalls, 0, "command-only acceptance must not call a model");
  } finally {
    await manager.shutdownAll();
    await new Promise<void>((resolveClose) => listener.close(() => resolveClose()));
  }
}

async function observePreexistingHardlink(options: {
  sentinel: string; alias: string; marker: string;
  attemptWrite: (path: string) => Promise<LocalAgentJsonValue>;
}): Promise<void> {
  const id = "W03a";
  try {
    linkSync(options.sentinel, options.alias);
    const result = parseLocalAgentJsonObject(await options.attemptWrite(options.alias));
    const sentinelAfter = readFileSync(options.sentinel, "utf8");
    const evidence = { result, sentinelAfter };
    writeFileSync(join(output, "pre-existing-hardlink.json"), JSON.stringify(evidence, null, 2));
    assert.equal(result.exitCode, 0, "hardlink operation reporter did not complete");
    const report = parseLocalAgentJsonObject(JSON.parse(String(result.stdout).trim()));
    assert.equal(report.marker, options.marker);
    assert.equal(report.kind, "write");
    if (report.written === true) {
      assert.equal(sentinelAfter, "UNSAFE", "hardlink operation and trusted observation disagree");
      results.push({ id, status: "KNOWN_LIMITATION", evidence,
        detail: "Accepted Codex-equivalent behavior (2026-10-18): a pre-existing project hardlink also changes its outside alias. See docs/local-agent-windows.md." });
      // Reset only this synthetic sentinel from the trusted harness so the next
      // independent traversal case has its original negative-control value.
      writeFileSync(options.sentinel, "outside-seed");
    } else {
      assert.equal(report.written, false);
      assert.ok(report.code === "EACCES" || report.code === "EPERM" || report.code === "EROFS");
      assert.equal(sentinelAfter, "outside-seed");
      results.push({ id, status: "PASS", evidence, detail: "This runtime additionally refused the pre-existing alias write." });
    }
  } catch (cause) {
    results.push({ id, status: "FAIL", detail: cause instanceof Error ? cause.message : String(cause) });
    throw cause;
  }
}

async function runCase(id: string, run: () => Promise<LocalAgentJsonValue>): Promise<void> {
  try {
    results.push({ id, status: "PASS", detail: "Native subset completed; see evidence.", evidence: await run() });
  } catch (cause) {
    results.push({ id, status: "FAIL", detail: cause instanceof Error ? cause.message : String(cause) });
    throw new Error(`${id} failed. Stop acceptance; preserve fixtures for review.`);
  }
}
