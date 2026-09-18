import { promises as fs } from "node:fs";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";

export const TURN_MENTION_FILE_ENV = "COCALC_AGENT_MENTION_REFERENCES_FILE";

// The spawner exports this path before starting Codex. Each scoped runtime has
// its own identity directory; turn/start does not support shell env overrides.
export function turnMentionFilePath(identityPath: string): string {
  return `${identityPath}.mentions.json`;
}

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
  const hostPath = turnMentionFilePath(identityHostPath);
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
    file: turnMentionFilePath(identityPath),
    cleanup: () => fs.rm(hostPath, { force: true }),
  };
}
