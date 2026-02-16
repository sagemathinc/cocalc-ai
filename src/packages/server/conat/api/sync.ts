import { conat } from "@cocalc/backend/conat";
import { type Patch, type HistoryInfo } from "@cocalc/conat/hub/api/sync";
import {
  history as historyImpl,
  purgeHistory as purgeHistoryImpl,
} from "@cocalc/conat/hub/api/sync-impl";
import { assertCollab } from "./util";

export async function history({
  account_id,
  project_id,
  path,
  start_seq = 0,
  end_seq,
}: {
  account_id?: string;
  project_id: string;
  path: string;
  start_seq?: number;
  end_seq?: number;
}): Promise<{ patches: Patch[]; info: HistoryInfo }> {
  return await historyImpl({
    account_id,
    project_id,
    path,
    start_seq,
    end_seq,
    client: conat(),
    assertAccess: assertCollab,
  });
}

export async function purgeHistory({
  account_id,
  project_id,
  path,
}: {
  account_id?: string;
  project_id: string;
  path: string;
}): Promise<{ deleted: number; history_epoch: number }> {
  return await purgeHistoryImpl({
    account_id,
    project_id,
    path,
    client: conat(),
    assertAccess: assertCollab,
  });
}
