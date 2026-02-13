import { conat as getConatClient } from "@cocalc/conat/client";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { type Patch, type HistoryInfo } from "@cocalc/conat/hub/api/sync";
import { client_db } from "@cocalc/util/db-schema/client-db";

type AssertAccessFn = (opts: {
  account_id?: string;
  project_id: string;
}) => Promise<void> | void;

function resolveConatClient(client?: any) {
  if (client?.sync != null) {
    return client;
  }
  if (typeof client?.conat === "function") {
    const raw = client.conat();
    if (raw?.sync != null) {
      return raw;
    }
  }
  return getConatClient();
}

export async function history({
  account_id,
  project_id,
  path,
  start_seq = 0,
  end_seq,
  client,
  assertAccess,
}: {
  account_id?: string;
  project_id: string;
  path: string;
  start_seq?: number;
  end_seq?: number;
  client?: any;
  assertAccess?: AssertAccessFn;
}): Promise<{ patches: Patch[]; info: HistoryInfo }> {
  await assertAccess?.({ account_id, project_id });

  const conatClient = resolveConatClient(client);
  const name = patchesStreamName({ path });
  const astream = conatClient.sync.astream({
    name,
    project_id,
    noInventory: true,
  });
  const patches: Patch[] = [];
  for await (const patch of await astream.getAll({
    start_seq,
    end_seq,
  })) {
    patches.push(patch as any);
  }

  const akv = conatClient.sync.akv({
    name: `__dko__syncstrings:${client_db.sha1(project_id, path)}`,
    project_id,
    noInventory: true,
  });
  const keys = await akv.keys();
  const info: Partial<HistoryInfo> = {};
  for (const key of keys) {
    if (key[0] != "[") continue;
    info[JSON.parse(key)[1]] = await akv.get(key);
  }

  return { patches, info: info as HistoryInfo };
}

export async function purgeHistory({
  account_id,
  project_id,
  path,
  keep_current_state = true,
  client,
  assertAccess,
}: {
  account_id?: string;
  project_id: string;
  path: string;
  keep_current_state?: boolean;
  client?: any;
  assertAccess?: AssertAccessFn;
}): Promise<{ deleted: number; seeded: boolean; history_epoch: number }> {
  await assertAccess?.({ account_id, project_id });

  const conatClient = resolveConatClient(client);
  const string_id = client_db.sha1(project_id, path);
  const name = patchesStreamName({ path });

  const syncstrings = await conatClient.sync.synctable({
    query: {
      syncstrings: [
        {
          string_id,
          project_id,
          path,
          users: null,
          last_snapshot: null,
          last_seq: null,
          snapshot_interval: null,
          save: null,
          last_active: null,
          init: null,
          read_only: null,
          last_file_change: null,
          doctype: null,
          archived: null,
          settings: null,
        },
      ],
    },
    stream: false,
    atomic: false,
    immutable: false,
    noInventory: true,
  });

  const getOne =
    (syncstrings as any).get_one ?? (syncstrings as any).getOne;
  const current = ((typeof getOne === "function"
    ? getOne.call(syncstrings)
    : undefined) ?? {
    string_id,
    project_id,
    path,
    settings: {},
    doctype: JSON.stringify({ type: "string", patch_format: 0 }),
  }) as Record<string, any>;

  const settings = (current.settings ?? {}) as Record<string, any>;
  const history_epoch =
    typeof settings.history_epoch === "number" &&
    Number.isFinite(settings.history_epoch)
      ? settings.history_epoch + 1
      : 1;
  const stream = conatClient.sync.astream({
    name,
    project_id,
    noInventory: true,
  });
  try {
    await stream.config({
      required_headers: { history_epoch },
    });
    const deleted = await stream.delete({ all: true });
    const nextSettings = {
      ...settings,
      history_epoch,
      history_purged_at: Date.now(),
      history_purged_by: account_id ?? null,
    };
    syncstrings.set({
      ...current,
      string_id,
      project_id,
      path,
      last_snapshot: null,
      last_seq: null,
      settings: nextSettings,
    });
    await syncstrings.save();

    return {
      deleted: deleted.seqs?.length ?? 0,
      seeded: false,
      history_epoch,
    };
  } finally {
    // keep_current_state is intentionally ignored in this generation-fenced model,
    // where open clients are closed and reopening recreates state safely.
    void keep_current_state;
    stream.close();
    syncstrings.close();
  }
}
