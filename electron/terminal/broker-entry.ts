import type { ParentPort } from "electron";

import { TerminalBrokerEndpoint } from "./broker-endpoint.js";
import { isWellFormedString } from "./protocol.js";
import { NodePtyHost } from "./node-pty-host.js";

type UtilityProcess = NodeJS.Process & { parentPort?: ParentPort };

const brokerId = process.argv[2];
const port = (process as UtilityProcess).parentPort;

if (!port || !isWellFormedString(brokerId) || brokerId.length === 0) {
  process.exitCode = 1;
} else {
  const endpoint = new TerminalBrokerEndpoint({
    brokerId,
    host: new NodePtyHost(),
    onShutdown: () => setImmediate(() => process.exit(0)),
    port,
  });
  process.once("exit", () => endpoint.dispose());
  endpoint.start();
}
