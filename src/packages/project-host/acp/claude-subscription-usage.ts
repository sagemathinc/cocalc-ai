import type { ClaudeSubscriptionUsage } from "@cocalc/util/ai/claude-usage";
import { parseClaudeSubscriptionUsage } from "@cocalc/util/ai/claude-usage";
import { CLAUDE_CODE_QUALIFICATION } from "@cocalc/util/ai/qualified-harnesses";
import { getClaudeSubscriptionCredential } from "./claude-subscription-registry";
import { launchClaudeSubscriptionController } from "./claude-subscription-controller";

const cache = new Map<
  string,
  { expires: number; result: Promise<ClaudeSubscriptionUsage> }
>();
let active = 0;

export async function getClaudeSubscriptionUsage(options: {
  projectId: string;
  accountId: string;
  credentialId: string;
}): Promise<ClaudeSubscriptionUsage> {
  // Reauthorize even cache hits: neither collaborators nor revoked credentials
  // may read another account's subscription usage.
  await getClaudeSubscriptionCredential(options);
  const key = JSON.stringify([
    options.projectId,
    options.accountId,
    options.credentialId,
  ]);
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.result;
  if (active >= 4)
    throw Error("Claude usage lookup is busy; try again shortly");
  for (const [key, entry] of cache)
    if (entry.expires <= Date.now()) cache.delete(key);
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  active++;
  const result = readUsage(options).finally(() => {
    active--;
  });
  // Cache failures briefly as well, avoiding repeated container launches on hover.
  cache.set(key, { expires: Date.now() + 60_000, result });
  return result;
}

async function readUsage({
  projectId,
  accountId,
  credentialId,
}: {
  projectId: string;
  accountId: string;
  credentialId: string;
}): Promise<ClaudeSubscriptionUsage> {
  const proc = await launchClaudeSubscriptionController(
    {
      projectId,
      accountId,
      credential: {
        version: 1,
        provider: "anthropic",
        mode: "account-subscription",
        credentialId,
      },
      profile: {
        version: 2,
        kind: "acp",
        id: "claude-code",
        revision: CLAUDE_CODE_QUALIFICATION.package.version,
        cwd: "/home/user",
        executionPolicy: "full-access",
        credentialMode: "project-managed",
      },
    },
    "usage",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bytes = 0;
  const chunks: Buffer[] = [];
  // Drain but never return/log stderr: provider failures may contain private data.
  proc.stderr.resume();
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error("Claude usage lookup timed out")),
        30_000,
      );
      proc.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) {
          reject(Error("Claude usage response too large"));
          return;
        }
        chunks.push(chunk);
      });
      proc.stdout.on("error", () =>
        reject(Error("Claude usage lookup failed")),
      );
      void proc.closed.then(
        () => resolve(Buffer.concat(chunks).toString("utf8")),
        () => reject(Error("Claude usage lookup failed")),
      );
    });
    try {
      return parseClaudeSubscriptionUsage(JSON.parse(raw));
    } catch {
      throw Error(
        "Claude usage is unavailable; try again after your next turn",
      );
    }
  } finally {
    clearTimeout(timer);
    await proc.stop();
  }
}
