import { createConnection } from "node:net";
import { describe, expect, test } from "bun:test";
import { createWindowsJobCompletion } from "./windows-job-completion.js";

describe("Windows job private completion proof", () => {
  test.skipIf(process.platform !== "win32")("retains the complete runtime status in an authenticated fixed frame", async () => {
    const completion = createWindowsJobCompletion();
    try {
      const frame = Buffer.alloc(40);
      frame.write("ARD1");
      frame.writeInt32LE(125, 4);
      Buffer.from(completion.nonce, "base64").copy(frame, 8);
      await sendFrame(completion.pipeName, frame);
      expect(await completion.result).toBe(125);
    } finally { completion.dispose(); }
  });

  for (const malformed of ["short", "oversized", "wrong-nonce", "wrong-version"]) {
    test.skipIf(process.platform !== "win32")(`rejects a ${malformed} completion frame`, async () => {
      const completion = createWindowsJobCompletion();
      let accepted = false;
      void completion.result.then(() => { accepted = true; }, () => {});
      try {
        const frame = Buffer.alloc(malformed === "short" ? 39 : malformed === "oversized" ? 41 : 40);
        frame.write(malformed === "wrong-version" ? "ARD2" : "ARD1");
        if (malformed !== "wrong-nonce") Buffer.from(completion.nonce, "base64").copy(frame, 8);
        await sendFrame(completion.pipeName, frame);
        expect(accepted).toBe(false);
        completion.dispose();
        await expect(completion.result).rejects.toThrow("completion was not verified");
      } finally { completion.dispose(); }
    });
  }
});

async function sendFrame(pipeName: string, frame: Buffer): Promise<void> {
  const socket = createConnection(`\\\\.\\pipe\\${pipeName}`);
  const closed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));
  try {
    await new Promise<void>((resolveConnect, reject) => {
      socket.once("connect", resolveConnect);
      socket.once("error", reject);
    });
    socket.end(frame);
    await closed;
  } finally { socket.destroy(); }
}
