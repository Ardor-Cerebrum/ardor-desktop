import { randomUUID } from "node:crypto";
import { mkdtempSync, rmdirSync } from "node:fs";
import { join, win32 } from "node:path";
import type { LocalAgentJsonValue } from "./protocol.js";

export const WINDOWS_MXC_UNAVAILABLE = "Protected local execution is unavailable: Windows MXC could not be verified. Update Windows and retry. Your local projects and saved chats have not been deleted. Cloud chats are unaffected.";

interface ReadinessOptions {
  readonly runtimeHome: string;
  readonly timeoutMs: number;
  readonly systemRoot: string | undefined;
  readonly request: (method: string, params: Record<string, LocalAgentJsonValue>, timeoutMs: number) => Promise<LocalAgentJsonValue>;
}

/** Private main-process check, never a renderer RPC or a sandbox setup request. */
export async function verifyWindowsMxc(options: ReadinessOptions): Promise<void> {
  let probeRoot: string | undefined;
  const deadline = Date.now() + options.timeoutMs;
  const request = (method: string, params: Record<string, LocalAgentJsonValue>) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(WINDOWS_MXC_UNAVAILABLE);
    return options.request(method, params, remainingMs);
  };
  try {
    const config = object(await request("config/read", { includeLayers: false }))?.config;
    const windows = object(object(config)?.windows);
    const profile = object(object(object(config)?.permissions)?.["ardor-local-workspace"]);
    if (windows?.sandbox !== "mxc" || object(config)?.default_permissions !== "ardor-local-workspace" ||
        profile?.extends !== ":workspace" || object(profile.network)?.enabled !== false ||
        object(profile.filesystem)?.[":tmpdir"] !== "read" || object(profile.filesystem)?.[":slash_tmp"] !== "read") {
      throw new Error(WINDOWS_MXC_UNAVAILABLE);
    }

    // Config/read is layered TOML, not the requirement-constrained backend.
    // Together with explicit mxc and the pinned runtime's selection contract,
    // this excludes policy-driven replacement before readiness can run setup.
    const constraints = object(await request("configRequirements/read", {}));
    if (!constraints || !("requirements" in constraints)) throw new Error(WINDOWS_MXC_UNAVAILABLE);
    const requirements = constraints.requirements;
    if (requirements !== null) {
      const policy = object(requirements);
      const allowed = policy?.allowed_windows_sandbox_implementations;
      const modes = policy?.allowed_sandbox_modes;
      const profiles = policy?.allowed_permission_profiles;
      if (!policy || (allowed != null && (!Array.isArray(allowed) || !allowed.includes("mxc"))) ||
          (modes != null && (!Array.isArray(modes) || !modes.includes("workspace-write"))) ||
          (profiles != null && object(profiles)?.["ardor-local-workspace"] !== true) ||
          (policy.default_permissions != null && policy.default_permissions !== "ardor-local-workspace")) {
        throw new Error(WINDOWS_MXC_UNAVAILABLE);
      }
    }
    if (object(await request("windowsSandbox/readiness", {}))?.status !== "ready") {
      throw new Error(WINDOWS_MXC_UNAVAILABLE);
    }
    if (!options.systemRoot || !/^[a-z]:[\\/]/i.test(options.systemRoot)) throw new Error(WINDOWS_MXC_UNAVAILABLE);
    probeRoot = mkdtempSync(join(options.runtimeHome, "mxc-probe-"));
    const marker = `ardor-mxc-${randomUUID()}`;
    const result = object(await request("command/exec", {
      command: [win32.join(options.systemRoot, "System32", "cmd.exe"), "/d", "/c", `echo ${marker}`],
      cwd: probeRoot,
      permissionProfile: "ardor-local-workspace",
      timeoutMs: Math.max(1, deadline - Date.now()),
      outputBytesCap: 4096,
      env: { ARDOR_DESKTOP_RELAY_TOKEN: null },
    }));
    if (result?.exitCode !== 0 || typeof result.stdout !== "string" || result.stdout.trim() !== marker) {
      throw new Error(WINDOWS_MXC_UNAVAILABLE);
    }
  } catch {
    // Do not surface native error text, config contents, paths or RPC traces.
    throw new Error(WINDOWS_MXC_UNAVAILABLE);
  } finally {
    // Only remove the empty synthetic directory; never recursively delete a
    // path a child could have populated or substituted.
    if (probeRoot) {
      try { rmdirSync(probeRoot); } catch { /* Retain unexpected contents for inspection. */ }
    }
  }
}

function object(value: LocalAgentJsonValue | undefined): Record<string, LocalAgentJsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
