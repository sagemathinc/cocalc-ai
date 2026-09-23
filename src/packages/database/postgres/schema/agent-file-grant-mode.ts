import type { Client } from "@cocalc/database/pool";

export async function ensureAgentFileGrantModeSchema(
  db: Client,
): Promise<void> {
  // Install the replacement before removing the legacy read-only constraint.
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid=to_regclass('agent_file_grants')
        AND conname='agent_file_grants_mode_v2_check') THEN
      ALTER TABLE agent_file_grants ADD CONSTRAINT agent_file_grants_mode_v2_check
        CHECK (mode IN ('read', 'read-write'));
    END IF;
    ALTER TABLE agent_file_grants DROP CONSTRAINT IF EXISTS agent_file_grants_mode_check;
  END $$`);
}
