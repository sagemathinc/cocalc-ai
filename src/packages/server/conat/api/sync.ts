import { conat } from "@cocalc/backend/conat";
import { patchesStreamName } from "@cocalc/conat/sync/synctable-stream";
import { type Patch, type HistoryInfo } from "@cocalc/conat/hub/api/sync";
import { client_db } from "@cocalc/util/db-schema/client-db";
import {
  createDbCodec,
  createImmerDbCodec,
  type DocCodec,
} from "@cocalc/sync/patchflow";
import {
  encodePatchId,
  makeClientId,
  StringDocument as PatchflowStringDocument,
} from "@cocalc/sync/patchflow";
import { projectApiClient } from "@cocalc/conat/project/api";
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
  await assertCollab({ account_id, project_id });

  const client = conat();
  const name = patchesStreamName({ path });
  const astream = client.sync.astream({
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

  const akv = client.sync.akv({
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

type DocType = {
  type?: string;
  patch_format?: number;
  opts?: Record<string, unknown>;
};

function toArray(val: unknown): string[] | undefined {
  if (Array.isArray(val)) return val;
  if (val instanceof Set) return Array.from(val);
  return undefined;
}

function parseDocType(doctype?: unknown): DocType {
  if (doctype == null) return { type: "string", patch_format: 0 };
  if (typeof doctype === "string") {
    try {
      const parsed = JSON.parse(doctype);
      if (parsed && typeof parsed === "object") {
        return parsed as DocType;
      }
    } catch {
      return { type: "string", patch_format: 0 };
    }
    return { type: "string", patch_format: 0 };
  }
  if (typeof doctype === "object") {
    return doctype as DocType;
  }
  return { type: "string", patch_format: 0 };
}

function codecFromDocType(doctype: DocType): DocCodec | undefined {
  if (doctype.patch_format !== 1) return;
  const opts = (doctype.opts ?? {}) as Record<string, unknown>;
  const primaryKeys =
    toArray(
      (opts as { primary_keys?: unknown; primaryKeys?: unknown }).primary_keys,
    ) ??
    toArray(
      (opts as { primary_keys?: unknown; primaryKeys?: unknown }).primaryKeys,
    );
  if (!primaryKeys || primaryKeys.length === 0) return;
  const stringCols =
    toArray(
      (opts as { string_cols?: unknown; stringCols?: unknown }).string_cols,
    ) ??
    toArray(
      (opts as { string_cols?: unknown; stringCols?: unknown }).stringCols,
    ) ??
    [];
  const type = doctype.type ?? "";
  if (typeof type === "string" && type.toLowerCase().includes("immer")) {
    return createImmerDbCodec({ primaryKeys, stringCols });
  }
  return createDbCodec({ primaryKeys, stringCols });
}

function makeInitialPatch({
  content,
  doctype,
}: {
  content: string;
  doctype: DocType;
}): { patch: unknown; format?: number } | undefined {
  if (content.length === 0) return;
  const codec = codecFromDocType(doctype);
  if (codec != null) {
    try {
      const from = codec.fromString("");
      const to = codec.fromString(content);
      const patch = codec.makePatch(from, to);
      return { patch, format: doctype.patch_format };
    } catch {
      return;
    }
  }
  const from = new PatchflowStringDocument("");
  const to = new PatchflowStringDocument(content);
  return { patch: from.makePatch(to), format: doctype.patch_format };
}

export async function purgeHistory({
  account_id,
  project_id,
  path,
  keep_current_state = true,
}: {
  account_id?: string;
  project_id: string;
  path: string;
  keep_current_state?: boolean;
}): Promise<{ deleted: number; seeded: boolean; history_epoch: number }> {
  await assertCollab({ account_id, project_id });

  const client = conat();
  const string_id = client_db.sha1(project_id, path);
  const name = patchesStreamName({ path });

  const syncstrings = await client.sync.synctable({
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

  const current = (syncstrings.get_one() ?? {
    string_id,
    project_id,
    path,
    settings: {},
    doctype: JSON.stringify({ type: "string", patch_format: 0 }),
  }) as Record<string, any>;

  const doctype = parseDocType(current.doctype);
  let seeded = false;
  const stream = client.sync.astream({ name, project_id, noInventory: true });
  try {
    const deleted = await stream.delete({ all: true });

    if (keep_current_state) {
      let content: string | undefined;
      try {
        const projectApi = projectApiClient({ client, project_id });
        content = await projectApi.system.readTextFileFromProject({ path });
      } catch {
        content = undefined;
      }

      if (typeof content === "string") {
        const initial = makeInitialPatch({ content, doctype });
        if (initial != null) {
          const wall = Date.now();
          await stream.publish({
            string_id,
            project_id,
            path,
            time: encodePatchId(wall, makeClientId()),
            wall,
            patch: JSON.stringify(initial.patch ?? []),
            user_id: 0,
            is_snapshot: false,
            parents: [],
            version: 1,
            file: true,
            ...(initial.format != null ? { format: initial.format } : {}),
          } as any);
          seeded = true;
        }
      }
    }

    const settings = (current.settings ?? {}) as Record<string, any>;
    const history_epoch =
      typeof settings.history_epoch === "number" &&
      Number.isFinite(settings.history_epoch)
        ? settings.history_epoch + 1
        : 1;
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
      seeded,
      history_epoch,
    };
  } finally {
    stream.close();
    syncstrings.close();
  }
}
