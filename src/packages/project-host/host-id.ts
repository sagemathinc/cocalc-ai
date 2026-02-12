import { randomUUID } from "crypto";
import { getRow, upsertRow } from "@cocalc/lite/hub/sqlite/database";

const HOST_ID_PK = "host-id";
const HOST_ID_TABLE = "project-host";

export function resolveProjectHostId(preferred?: string): string {
  const stored = getRow(HOST_ID_TABLE, HOST_ID_PK)?.hostId as
    | string
    | undefined;
  const resolved =
    preferred ?? process.env.PROJECT_HOST_ID ?? stored ?? randomUUID();
  if (stored !== resolved) {
    upsertRow(HOST_ID_TABLE, HOST_ID_PK, { hostId: resolved });
  }
  process.env.PROJECT_HOST_ID = resolved;
  return resolved;
}
