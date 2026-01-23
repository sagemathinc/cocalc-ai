import getLogger from "@cocalc/backend/logger";
import { pairSelfHostConnector } from "@cocalc/server/self-host/pair";

const logger = getLogger("launchpad:local:ssh-pair");

async function readStdin(): Promise<string> {
  return await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("close", () => resolve(data));
  });
}

function writeJson(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main() {
  const raw = (await readStdin()).trim();
  if (!raw) {
    throw new Error("missing pairing payload");
  }
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid json payload: ${String(err)}`);
  }
  const pairingToken = String(payload?.pairing_token ?? "").trim();
  if (!pairingToken) {
    throw new Error("missing pairing token");
  }
  const connectorInfo = (payload?.connector_info ?? {}) as Record<string, any>;
  const response = await pairSelfHostConnector({
    pairingToken,
    connectorInfo,
  });
  writeJson(response);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn("ssh pairing failed", { err: message });
  writeJson({ error: message });
  process.exit(1);
});
