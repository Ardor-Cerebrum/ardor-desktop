import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveVerifiedLocalAgentBundle } from "../electron/local-agent/bundle.js";
import { parseLocalAgentJsonObject, type LocalAgentJsonValue } from "../electron/local-agent/protocol.js";
import { LocalResponsesRelay } from "../electron/local-agent/responses-relay.js";
import { LocalAgentRuntimeManager } from "../electron/local-agent/runtime-manager.js";
import {
  buildLocalAgentEnvironment,
  buildLocalAgentProviderConfig,
  createLocalAgentStdioProcess,
} from "../electron/local-agent/stdio-process.js";

// NOTE(ARD-2319): Run the real bundled engine through Desktop's Node components.
// The upstream SSE is a fixture; live Haron authorization/billing needs separate acceptance.
const bundleRoot = resolvePackagedRuntimeRoot();
const runtimeConfigPath = resolve(bundleRoot, "..", "runtime-config.json");
const config = parseLocalAgentJsonObject(JSON.parse(readFileSync(runtimeConfigPath, "utf8")));
if (typeof config.cerebrumSourceCommit !== "string" || typeof config.cerebrumManifestSha256 !== "string") {
  throw new Error("Packaged Desktop is missing its trusted Cerebrum pins.");
}
const bundle = resolveVerifiedLocalAgentBundle(
  bundleRoot, process.platform, process.arch, config.cerebrumSourceCommit, config.cerebrumManifestSha256,
);
const root = mkdtempSync(join(tmpdir(), "ardor-local-agent-smoke-"));
const project = join(root, "проект with spaces");
mkdirSync(project);
const outside = join(root, "outside");
mkdirSync(outside);
const scope = { accountId: "stage-smoke-account", workspaceId: "stage-smoke-workspace" };
const apiOrigin = "https://console.ardor.cloud";
const forwarded: Array<{ url: string; workspace: string | null; thread: string | null; authorization: string | null }> = [];
const events: Array<Record<string, LocalAgentJsonValue>> = [];
let interruptedStreamCancelled = false;
let interruptedRequestSignal: AbortSignal | null | undefined;
const relay = new LocalResponsesRelay({
  apiOrigin, runtimeId: "stage-smoke-runtime", generation: 1, scope,
  getAccessToken: async () => "stage-smoke-internal-token",
  fetch: async (input, init) => {
    const headers = new Headers(init?.headers);
    forwarded.push({
      url: String(input), workspace: headers.get("x-ardor-workspace-id"),
      thread: headers.get("thread-id"), authorization: headers.get("authorization"),
    });
    if (forwarded.length === 2) {
      interruptedRequestSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"stage-stop-response"}}\n\n'));
          // Match fetch: aborting the request also rejects a pending body read.
          const abort = () => {
            interruptedStreamCancelled = true;
            controller.error(new DOMException("Request aborted", "AbortError"));
          };
          init?.signal?.addEventListener("abort", abort, { once: true });
          if (init?.signal?.aborted) abort();
        },
        cancel() { interruptedStreamCancelled = true; },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const body = [
      { type: "response.created", response: { id: "stage-smoke-response" } },
      { type: "response.output_item.added", item: { type: "message", role: "assistant", id: "stage-smoke-message", content: [{ type: "output_text", text: "" }] } },
      { type: "response.output_text.delta", delta: "Runtime " },
      { type: "response.output_text.delta", delta: "relay works." },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "stage-smoke-message", content: [{ type: "output_text", text: "Runtime relay works." }] } },
      { type: "response.completed", response: { id: "stage-smoke-response", usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  },
});
const options = {
  channel: "stage1", userDataPath: root, platform: process.platform,
  createProcess: async (processOptions: { runtimeHome: string }) => {
    const port = await relay.start();
    writeFileSync(join(processOptions.runtimeHome, "config.toml"), buildLocalAgentProviderConfig(port));
    return createLocalAgentStdioProcess({
      command: bundle.executablePath, args: bundle.args, cwd: processOptions.runtimeHome,
      env: buildLocalAgentEnvironment(process.env, processOptions.runtimeHome, relay.token), platform: process.platform,
    });
  },
};
let manager = new LocalAgentRuntimeManager(options);
try {
  manager.onEvent(({ message }) => { events.push(message); });
  manager.authorizeProjectFolder(scope, project);
  const runtime = await manager.connect(scope);
  assert.equal(runtime.state, "ready");
  const createRequest = { id: 1, method: "thread/start", params: { model: "gpt-5.4", modelProvider: "ardor" } };
  const started = parseLocalAgentJsonObject(await manager.request(
    runtime.runtimeId, runtime.generation, createRequest, { cwd: project }, "smoke-thread",
  ));
  const thread = parseLocalAgentJsonObject(started.thread);
  if (typeof thread.id !== "string") throw new Error("Bundled runtime did not return a thread identity.");
  const threadId = thread.id;
  const context = { cwd: project, threadId };
  const createWriteCommand = (filePath: string, content: string) =>
    `require("node:fs").writeFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(content)}, "utf8")`;
  const commandPath = join(project, "desktop-command.txt");
  const commandResult = parseLocalAgentJsonObject(await manager.request(
    runtime.runtimeId,
    runtime.generation,
    {
      id: 6,
      method: "command/exec",
      params: {
        command: [process.execPath, "-e", createWriteCommand(commandPath, "desktop-policy-ok")],
        cwd: outside,
        timeoutMs: 10_000,
        sandboxPolicy: { type: "dangerFullAccess" },
        permissionProfile: "unrestricted",
      },
    },
    context,
  ));
  assert.equal(commandResult.exitCode, 0, "Desktop local policy did not allow a command write inside the project");
  assert.equal(readFileSync(commandPath, "utf8"), "desktop-policy-ok");

  const outsideCommandPath = join(outside, "command-outside.txt");
  writeFileSync(outsideCommandPath, "outside-seed", "utf8");
  let outsideCommandResult: Record<string, LocalAgentJsonValue> | null = null;
  let outsideCommandError = "";
  try {
    outsideCommandResult = parseLocalAgentJsonObject(await manager.request(
      runtime.runtimeId,
      runtime.generation,
      {
        id: 7,
        method: "command/exec",
        params: {
          command: [process.execPath, "-e", createWriteCommand(outsideCommandPath, "unsafe")],
          cwd: project,
          timeoutMs: 10_000,
        },
      },
      context,
    ));
  } catch (error) {
    outsideCommandError = error instanceof Error ? error.message : String(error);
  }
  const outsideCommandOutput = `${outsideCommandResult?.stderr ?? ""} ${outsideCommandError}`.toLowerCase();
  const outsideCommandDetails = JSON.stringify({
    result: outsideCommandResult,
    error: outsideCommandError,
    outsideFileContent: readFileSync(outsideCommandPath, "utf8"),
  });
  assert.match(
    outsideCommandOutput,
    /permission denied|operation not permitted|access is denied|is not permitted|read-only file system/,
    `Desktop local policy did not report a sandbox denial for a command write outside the project: ${outsideCommandDetails}`,
  );
  assert.equal(readFileSync(outsideCommandPath, "utf8"), "outside-seed", "an outside-project command write succeeded");

  await manager.request(runtime.runtimeId, runtime.generation,
    { id: 2, method: "turn/start", params: { threadId, input: [{ type: "text", text: "Hello", text_elements: [] }] } },
    context, "smoke-turn",
  );
  const deadline = Date.now() + 30_000;
  while (!events.some((event) => event.method === "turn/completed") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(events.some((event) => event.method === "item/agentMessage/delta"), "streamed text delta was not received");
  assert.ok(JSON.stringify(events).includes("Runtime relay works."), "assistant output was not received");
  const completed = events.find((event) => event.method === "turn/completed");
  assert.ok(completed, "turn did not complete");
  const completedTurn = parseLocalAgentJsonObject(parseLocalAgentJsonObject(completed.params).turn);
  assert.equal(completedTurn.status, "completed", "turn completed with an error");
  assert.deepEqual(forwarded, [{
    url: `${apiOrigin}/haron-api/api/cerebrum/desktop/responses`, workspace: scope.workspaceId,
    thread: threadId, authorization: "Bearer stage-smoke-internal-token",
  }]);
  const stopping = parseLocalAgentJsonObject(await manager.request(runtime.runtimeId, runtime.generation,
    { id: 4, method: "turn/start", params: { threadId, input: [{ type: "text", text: "Wait for stop", text_elements: [] }] } },
    context, "smoke-stop-turn",
  ));
  const stoppingTurn = parseLocalAgentJsonObject(stopping.turn);
  if (typeof stoppingTurn.id !== "string") throw new Error("Bundled runtime did not return a turn identity.");
  const stopDeadline = Date.now() + 30_000;
  while (forwarded.length < 2 && Date.now() < stopDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(forwarded.length, 2, "second model stream did not start");
  await manager.request(runtime.runtimeId, runtime.generation,
    { id: 5, method: "turn/interrupt", params: { threadId, turnId: stoppingTurn.id } }, context,
  );
  const isInterrupted = () => events.some((event) => {
    if (event.method !== "turn/completed") return false;
    const turn = parseLocalAgentJsonObject(parseLocalAgentJsonObject(event.params).turn);
    return turn.id === stoppingTurn.id && turn.status === "interrupted";
  });
  while ((!isInterrupted() || !interruptedStreamCancelled) && Date.now() < stopDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(isInterrupted(), "running turn was not interrupted");
  assert.ok(interruptedRequestSignal?.aborted, "stop did not abort the upstream fetch");
  assert.ok(interruptedStreamCancelled, "stop did not cancel the upstream model stream");
  await manager.shutdownAll();
  manager = new LocalAgentRuntimeManager(options);
  const reconnected = await manager.connect(scope);
  assert.equal(reconnected.runtimeId, runtime.runtimeId);
  const resumed = await manager.request(reconnected.runtimeId, reconnected.generation,
    { id: 3, method: "thread/resume", params: { threadId } }, context,
  );
  assert.ok(JSON.stringify(resumed).includes("Runtime relay works."), "local history did not survive a runtime restart");
  const replayed = await manager.request(reconnected.runtimeId, reconnected.generation,
    createRequest, { cwd: project }, "smoke-thread",
  );
  assert.deepEqual(replayed, started, "a duplicate create operation changed the chat");
  console.log("Verified bundled runtime through Desktop manager/relay: project-scoped command writes, outside-project command denial, streaming text, scoped user-token forwarding, stop, persisted resume and duplicate-create recovery.");
} finally {
  await manager.shutdownAll();
  await relay.stop();
  // Node yields while Windows releases the exited process's directory handles.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function resolvePackagedRuntimeRoot(): string {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  if (process.platform === "win32" && process.arch === "x64") {
    return resolve(projectRoot, "out", "Ardor Dev-win32-x64", "resources", "cerebrum");
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return resolve(projectRoot, "out", "Ardor Dev-darwin-arm64", "Ardor Dev.app", "Contents", "Resources", "cerebrum");
  }
  throw new Error(`Packaged local-agent smoke is unsupported on ${process.platform}/${process.arch}.`);
}
