import getLogger from "@cocalc/backend/logger";
import { getLaunchpadLocalConfig } from "./mode";

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
  const baseOverride = String(process.env.COCALC_SELF_HOST_PAIR_URL ?? "").trim();
  const config = getLaunchpadLocalConfig("local");
  const port = config.http_port ?? 9001;
  const baseUrl =
    baseOverride ||
    `http://127.0.0.1:${port}`;
  const resp = await fetch(`${baseUrl}/self-host/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
  if (!resp.ok) {
    const text = (await resp.text()).trim();
    throw new Error(text || `pair failed (${resp.status})`);
  }
  const response = await resp.json();
  writeJson(response);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.warn("ssh pairing failed", { err: message });
  writeJson({ error: message });
  process.exit(1);
});
