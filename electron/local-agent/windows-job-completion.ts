import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Socket } from "node:net";

const FRAME_BYTES = 40;
const MAGIC = Buffer.from("ARD1");

/** A private control channel, separate from untrusted runtime stdout/stderr. */
export function createWindowsJobCompletion(): {
  pipeName: string;
  nonce: string;
  result: Promise<number>;
  dispose: () => void;
} {
  const pipeName = `ArdorLocalAgentJob-${randomUUID()}`;
  const nonce = randomBytes(32);
  const sockets = new Set<Socket>();
  let disposed = false;
  let settled = false;
  let resolveResult: (code: number) => void = () => {};
  let rejectResult: (error: Error) => void = () => {};
  const result = new Promise<number>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A controller can fail before stop() attaches its own rejection handler.
  void result.catch(() => undefined);
  const server = createServer((socket) => {
    if (disposed) { socket.destroy(); return; }
    sockets.add(socket);
    let frame = Buffer.alloc(0);
    socket.setTimeout(1_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      if (frame.length + chunk.length > FRAME_BYTES) { socket.destroy(); return; }
      frame = Buffer.concat([frame, chunk]);
    });
    socket.once("end", () => {
      if (frame.length !== FRAME_BYTES) return;
      if (!frame.subarray(0, 4).equals(MAGIC) || !timingSafeEqual(frame.subarray(8), nonce)) {
        socket.destroy();
        return;
      }
      settled = true;
      resolveResult(frame.readInt32LE(4));
      dispose();
    });
  });
  server.maxConnections = 4;
  server.on("error", () => dispose());
  server.once("listening", () => { if (disposed) server.close(); });
  try {
    server.listen(`\\\\.\\pipe\\${pipeName}`);
  } catch (error) {
    dispose();
    throw error;
  }
  return { pipeName, nonce: nonce.toString("base64"), result, dispose };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (!settled) {
      settled = true;
      rejectResult(new Error("Local Cerebrum Windows job completion was not verified."));
    }
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server.listening) server.close();
  }
}
