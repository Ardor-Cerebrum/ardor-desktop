/** A local tool may outlive its model stream, so its authority has its own lifetime. */
export function startCredentialWatch(options: {
  verify: () => Promise<void>;
  onRevoked: () => void;
  intervalMs?: number;
}): () => void {
  const intervalMs = options.intervalMs ?? 15_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError("Invalid credential check interval.");
  let active = true;
  let timer: ReturnType<typeof setTimeout>;
  const check = async () => {
    try {
      await options.verify();
    } catch {
      if (active) {
        active = false;
        options.onRevoked();
      }
      return;
    }
    if (active) timer = setTimeout(() => { void check(); }, intervalMs);
  };
  timer = setTimeout(() => { void check(); }, intervalMs);
  return () => { active = false; clearTimeout(timer); };
}
