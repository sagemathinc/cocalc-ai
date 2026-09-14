import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";

export const TURN_MENTION_FILE_ENV = "COCALC_AGENT_MENTION_REFERENCES_FILE";

export async function materializeTurnMentionFile({
  identityPath,
  identityHostPath,
  references,
}: {
  identityPath?: string;
  identityHostPath?: string;
  references: readonly AgentMentionReference[];
}): Promise<{ file?: string; cleanup: () => Promise<void> }> {
  if (!identityPath || !identityHostPath) {
    if (references.length)
      throw new Error("Scoped agent identity is required for bound references");
    return { cleanup: async () => {} };
  }
  // Read only the trusted spawner's identity, never a request-provided path.
  const identity = JSON.parse(await fs.readFile(identityHostPath, "utf8"));
  if (!identity.agent_id || !identity.run_id)
    throw new Error("Invalid scoped agent identity");
  const name = `mentions-${randomUUID()}.json`;
  const hostPath = path.join(path.dirname(identityHostPath), name);
  await fs.writeFile(
    hostPath,
    JSON.stringify({
      agent_id: identity.agent_id,
      run_id: identity.run_id,
      references: references.map(({ name, target }) => ({ name, target })),
    }),
    { mode: 0o600, flag: "wx" },
  );
  return {
    file: path.join(path.dirname(identityPath), name),
    cleanup: () => fs.rm(hostPath, { force: true }),
  };
}
