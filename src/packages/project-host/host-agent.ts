import getLogger from "@cocalc/backend/logger";
import { ensureDaemon } from "./daemon";

const logger = getLogger("project-host:host-agent");

function parseIndex(argv: string[]): number {
  const indexFlag = argv.findIndex((arg) => arg === "--index");
  const raw =
    (indexFlag >= 0 ? argv[indexFlag + 1] : undefined) ??
    process.env.COCALC_PROJECT_HOST_AGENT_INDEX ??
    "0";
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `invalid host-agent index "${raw}"; expected a non-negative integer`,
    );
  }
  return index;
}

function getPollMs(): number {
  const raw = Number(process.env.COCALC_PROJECT_HOST_AGENT_POLL_MS ?? 5000);
  if (!Number.isFinite(raw) || raw < 1000) {
    return 5000;
  }
  return Math.floor(raw);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const index = parseIndex(argv);
  const pollMs = getPollMs();
  let stopping = false;

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("host-agent shutting down", { signal, index });
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  logger.info("host-agent started", { index, poll_ms: pollMs });

  while (!stopping) {
    try {
      ensureDaemon(index, {
        quietHealthy: true,
        preserveManagedAuxiliaryDaemons: true,
      });
    } catch (err) {
      logger.warn("host-agent reconcile failed", { index, err: `${err}` });
    }
    if (stopping) {
      break;
    }
    await sleep(pollMs);
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error("host-agent failed", err);
    process.exitCode = 1;
  });
}
