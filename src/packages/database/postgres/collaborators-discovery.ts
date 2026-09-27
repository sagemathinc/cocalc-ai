/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "./account-rehome-fence";
import {
  collaborationAgentPins,
  EFFECTIVE_ALIAS,
  effectiveCollected,
  LEGACY_PERSONAL_JOINS,
  RETAIN_PERSONAL_CHOICE,
} from "./collaborators-personal";
import {
  COLLABORATION_PAGE_LIMIT,
  emptyCollaborationPersonalState,
} from "@cocalc/util/collaborators";
import type {
  CollaborationPage,
  CollaborationPerson,
  CollaborationPersonalState,
  CollaborationProject,
  CollaborationProjectQuery,
  CollaborationQuery,
  CollaborationResource,
  CollaborationResourceQuery,
  CollaborationTarget,
} from "@cocalc/util/collaborators";
import {
  boundedText,
  entryKey,
  hash,
  integer,
  PAGE_BYTES,
  uuid,
  validateTarget,
} from "./collaborators-common";

// The access row is an owner-validated, expiring grant. The ordinary project
// projection is a second gate, not an authority that can renew that grant.
const ACCESS = `JOIN account_project_index p ON p.account_id=x.account_id AND p.project_id=x.project_id`;
const VISIBLE = `x.lease_until>now() AND COALESCE(x.granted_generation,x.generation) IS NOT NULL
  AND p.users_summary #>> ARRAY[x.account_id::text,'group'] IN ('owner','collaborator')`;

function query(input: CollaborationResourceQuery, mode: string) {
  uuid(input.account_id, "account_id");
  if (input.project_id != null) uuid(input.project_id, "project_id");
  if (input.person_id != null) uuid(input.person_id, "person_id");
  const search = boundedText(input.search ?? "", "search", 128, true).trim();
  const limit = input.limit ?? COLLABORATION_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > COLLABORATION_PAGE_LIMIT)
    throw Error("invalid page limit");
  if (
    input.kind != null &&
    !["agent", "artifact", "conversation"].includes(input.kind)
  )
    throw Error("invalid kind");
  if (
    input.scope != null &&
    !["all", "for-you", "following", "collected"].includes(input.scope)
  )
    throw Error("invalid scope");
  if (
    input.include_archived != null &&
    typeof input.include_archived !== "boolean"
  )
    throw Error("invalid include_archived");
  const binding = hash(
    JSON.stringify([
      mode,
      input.account_id,
      input.project_id ?? null,
      input.person_id ?? null,
      search,
      input.kind ?? null,
      input.scope ?? "all",
      !!input.include_archived,
    ]),
  );
  let after: { order: number; key: string } | undefined;
  if (input.after != null) {
    boundedText(input.after, "cursor", 2048);
    try {
      const value = JSON.parse(
        Buffer.from(input.after, "base64url").toString(),
      );
      if (
        value.v !== 1 ||
        value.binding !== binding ||
        !Number.isFinite(value.expires) ||
        value.expires < Date.now()
      )
        throw Error();
      integer(value.order, "cursor order");
      boundedText(value.key, "cursor key", 64);
      after = { order: value.order, key: value.key };
    } catch {
      throw Error("invalid or expired collaboration cursor; restart paging");
    }
  }
  return {
    ...input,
    account_id: input.account_id!,
    search,
    limit,
    binding,
    after,
  };
}
function next(binding: string, order: number, key: string) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      binding,
      order,
      key,
      expires: Date.now() + 10 * 60 * 1000,
    }),
  ).toString("base64url");
}
export { query as collaborationPageQuery, next as collaborationNextCursor };
async function coverage(
  account_id: string,
  project_id?: string,
  project_ids?: string[],
): Promise<Pick<CollaborationPage<never>, "coverage" | "coverage_message">> {
  const result = await getPool().query(
    `SELECT EXISTS(SELECT 1 FROM account_project_index p
    LEFT JOIN collaboration_access x USING(account_id,project_id)
    WHERE p.account_id=$1 AND ($2::uuid IS NULL OR p.project_id=$2)
    AND ($3::uuid[] IS NULL OR p.project_id=ANY($3::uuid[]))
    AND p.users_summary #>> ARRAY[p.account_id::text,'group'] IN ('owner','collaborator')
    AND (x.generation IS NULL OR x.lease_until<=now() OR NOT x.complete OR x.last_error IS NOT NULL)) AS pending`,
    [account_id, project_id ?? null, project_ids ?? null],
  );
  return result.rows[0].pending
    ? {
        coverage: "indexing",
        coverage_message:
          "Metadata is being indexed or access could not be refreshed. Unverified results are hidden.",
      }
    : {
        coverage: "partial",
        coverage_message:
          "Indexed sources only; legacy chats may be absent. Participant summaries are bounded, so person filters may omit participants.",
      };
}
function personal(row: any): CollaborationPersonalState {
  return {
    ...emptyCollaborationPersonalState(),
    ...(row?.alias ? { alias: row.alias } : {}),
    collected: !!row?.collected,
    following: !!row?.following,
    muted: !!row?.muted,
    read_through: Number(row?.read_through ?? 0),
  };
}
function resource(row: any, account_id: string): CollaborationResource {
  const state = personal(row);
  return {
    ...row.metadata,
    project_title: row.project_title,
    personal: state,
    ...(Number(row.last_mention ?? 0) >
    Math.max(state.read_through, Number(row.notify_after ?? 0))
      ? { reason: "mention" as const }
      : state.following
        ? { reason: "following" as const }
        : row.metadata.participant_ids?.includes(account_id)
          ? { reason: "participation" as const }
          : {}),
  };
}
async function page<T>(
  rows: any[],
  opts: ReturnType<typeof query>,
  map: (row: any) => T,
  order: (row: any) => number,
  key: (row: any) => string,
  coverageProjects?: string[],
): Promise<CollaborationPage<T>> {
  const items: T[] = [];
  let bytes = 2048;
  for (const row of rows.slice(0, opts.limit)) {
    const item = map(row);
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > PAGE_BYTES) break;
    items.push(item);
    bytes += size;
  }
  const last = rows[items.length - 1];
  return {
    items,
    ...(last && rows.length > items.length
      ? { next: next(opts.binding, order(last), key(last)) }
      : {}),
    ...(await coverage(opts.account_id, opts.project_id, coverageProjects)),
  };
}

export async function listCollaborationResources(
  input: CollaborationResourceQuery,
): Promise<CollaborationPage<CollaborationResource>> {
  const q = query(input, "resources");
  const values: any[] = [q.account_id];
  const param = (value: any) => {
    values.push(value);
    return `$${values.length}`;
  };
  const pins = param(await collaborationAgentPins(q.account_id));
  const collected = effectiveCollected(pins);
  let matches = "";
  let from = "collaboration_index r";
  const access = [
    VISIBLE,
    "r.generation=x.generation",
    "r.generation=COALESCE(x.granted_generation,x.generation)",
  ];
  const where = ["r.account_id=$1"];
  if (q.project_id) where.push(`r.project_id=${param(q.project_id)}::uuid`);
  if (q.person_id) {
    const v = param(q.person_id);
    where.push(
      `(r.created_by=${v}::uuid OR r.participant_ids @> ARRAY[${v}::uuid])`,
    );
  }
  if (q.kind) where.push(`r.kind=${param(q.kind)}`);
  if (q.search) {
    const search = param(q.search);
    // Separate indexed candidate sets avoid an OR across joined aliases turning
    // a selective title query into a scan of every resource in the account.
    matches = `WITH collaboration_matches AS MATERIALIZED (
      SELECT entry_key FROM collaboration_index WHERE account_id=$1 AND to_tsvector('simple',search_text) @@ plainto_tsquery('simple',${search})
      UNION SELECT i.entry_key FROM agent_personal_names n JOIN collaboration_index i ON
        i.account_id=n.account_id AND i.project_id=n.project_id AND i.kind='agent' AND i.metadata->>'agent_id'=n.agent_id::text
        WHERE n.account_id=$1 AND n.retired_at IS NULL AND to_tsvector('simple',n.name) @@ plainto_tsquery('simple',${search})
      UNION SELECT i.entry_key FROM personal_library_aliases n JOIN collaboration_index i ON
        i.account_id=n.account_id AND i.project_id=n.project_id AND i.kind='artifact' AND i.metadata->>'entry_id'=n.entry_id
        WHERE n.account_id=$1 AND n.active AND to_tsvector('simple',n.name) @@ plainto_tsquery('simple',${search})
      )`;
    // OFFSET 0 keeps the PK lookup parameterized instead of allowing a hash
    // join to scan the entire account for a one-row search candidate set.
    from = `collaboration_matches matches JOIN LATERAL (
      SELECT * FROM collaboration_index candidate WHERE candidate.account_id=$1 AND candidate.entry_key=matches.entry_key OFFSET 0
    ) r ON TRUE`;
  }
  if (!q.include_archived)
    where.push("NOT COALESCE((r.metadata->>'archived')::boolean,FALSE)");
  if (q.scope && q.scope !== "all") {
    let candidates =
      "SELECT entry_key FROM collaboration_personal WHERE account_id=$1 AND following";
    if (q.scope === "for-you")
      candidates += `
      UNION SELECT entry_key FROM collaboration_personal WHERE account_id=$1 AND last_mention>GREATEST(read_through,notify_after)
      UNION SELECT entry_key FROM collaboration_index WHERE account_id=$1 AND participant_ids @> ARRAY[$1::uuid]`;
    if (q.scope === "collected")
      candidates = `
      SELECT s.entry_key FROM collaboration_personal s WHERE s.account_id=$1 AND s.collected
        AND EXISTS(SELECT 1 FROM collaboration_index i WHERE i.account_id=s.account_id AND i.entry_key=s.entry_key AND i.kind IN ('agent','conversation') OFFSET 0)
      UNION SELECT entry_key FROM collaboration_index WHERE account_id=$1 AND kind='agent' AND metadata->>'agent_id'=ANY(${pins}::text[])
      UNION SELECT i.entry_key FROM personal_library_pins p JOIN LATERAL (
        SELECT entry_key FROM collaboration_index WHERE account_id=p.account_id AND kind='artifact'
          AND project_id=(p.pin_key::jsonb->>0)::uuid AND metadata->>'chat_path'=p.pin_key::jsonb->>1
          AND metadata->>'thread_id'=p.pin_key::jsonb->>2 AND metadata->>'artifact_id'=p.pin_key::jsonb->>3 OFFSET 0
      ) i ON TRUE WHERE p.account_id=$1`;
    matches = `${matches}${matches ? "," : "WITH"} collaboration_scope AS MATERIALIZED (${candidates}),
      collaboration_candidates AS MATERIALIZED (SELECT entry_key FROM collaboration_scope
        ${q.search ? "INTERSECT SELECT entry_key FROM collaboration_matches" : ""})`;
    from = `collaboration_candidates matches JOIN LATERAL (
      SELECT * FROM collaboration_index candidate WHERE candidate.account_id=$1 AND candidate.entry_key=matches.entry_key OFFSET 0
    ) r ON TRUE`;
  }
  if (q.after)
    where.push(
      `(r.activity,r.entry_key)<(${param(q.after.order)}::bigint,${param(q.after.key)}::text)`,
    );
  const limit = param(q.limit + 1);
  // Keep the ordered resource scan outside the membership join. OFFSET 0
  // prevents EXISTS from becoming a project-first join and a full-account
  // top-N sort. Authorization precedes LIMIT; personal overlays follow it.
  matches = `${matches}${matches ? "," : "WITH"} collaboration_page AS MATERIALIZED (
      SELECT r.* FROM ${from} WHERE ${where.join(" AND ")}
      AND EXISTS(SELECT 1 FROM collaboration_access x ${ACCESS}
        WHERE x.account_id=r.account_id AND x.project_id=r.project_id
        AND ${access.join(" AND ")} OFFSET 0)
      ORDER BY r.activity DESC,r.entry_key DESC LIMIT ${limit}
    )`;
  from = "collaboration_page r";
  const accessJoin =
    "JOIN account_project_index p ON p.account_id=r.account_id AND p.project_id=r.project_id";
  where.splice(0, where.length, "TRUE");
  const { rows } = await getPool().query(
    `${matches} SELECT r.entry_key,r.activity,r.metadata,left(p.title,128) AS project_title,
    ${EFFECTIVE_ALIAS} AS alias,${collected} AS collected,s.following,s.muted,s.read_through,s.last_mention,s.notify_after FROM ${from}
    ${accessJoin}
    LEFT JOIN collaboration_personal s ON s.account_id=r.account_id AND s.entry_key=r.entry_key
    ${LEGACY_PERSONAL_JOINS}
    WHERE ${where.join(" AND ")} ORDER BY r.activity DESC,r.entry_key DESC LIMIT ${limit}`,
    values,
  );
  return page(
    rows,
    q,
    (row) => resource(row, q.account_id),
    (row) => Number(row.activity),
    (row) => row.entry_key,
  );
}

export async function listCollaborationProjects(
  input: CollaborationProjectQuery,
  pinnedProjects: string[] = [],
): Promise<CollaborationPage<CollaborationProject>> {
  const view = input.view ?? "recent";
  if (view !== "recent" && view !== "pinned")
    throw Error("invalid project view");
  if (pinnedProjects.length > 10_000)
    throw Error("project favorites limit exceeded");
  for (const id of pinnedProjects) uuid(id, "pinned project");
  const pins = [...new Set(pinnedProjects)].sort();
  const q = query(input, `projects:${view}:${hash(JSON.stringify(pins))}`);
  if (q.after) uuid(q.after.key, "project cursor");
  const { rows } = await getPool().query(
    `SELECT p.project_id,left(p.title,512) AS title,left(p.description,1024) AS description,
    p.users_summary #>> ARRAY[$1::text,'group'] AS role,
    floor(extract(epoch FROM COALESCE(p.sort_key,'epoch'::timestamp))*1000)::bigint AS activity,
    p.project_id=ANY($8::uuid[]) AS pinned
    FROM collaboration_access x ${ACCESS} WHERE x.account_id=$1::uuid AND ${VISIBLE}
    AND ($2::uuid IS NULL OR p.project_id=$2)
    AND ($3::uuid IS NULL OR p.users_summary #>> ARRAY[$3::text,'group'] IN ('owner','collaborator'))
    AND ($4='' OR to_tsvector('simple',COALESCE(p.title,'')) @@ plainto_tsquery('simple',$4))
    AND ($5::bigint IS NULL OR (floor(extract(epoch FROM COALESCE(p.sort_key,'epoch'::timestamp))*1000)::bigint,p.project_id)<($5,$6::uuid))
    AND ($9::boolean IS FALSE OR p.project_id=ANY($8::uuid[]))
    ORDER BY activity DESC,p.project_id DESC LIMIT $7`,
    [
      q.account_id,
      q.project_id ?? null,
      q.person_id ?? null,
      q.search,
      q.after?.order ?? null,
      q.after?.key ?? null,
      q.limit + 1,
      pins,
      view === "pinned",
    ],
  );
  return page(
    rows,
    q,
    (row) => ({
      project_id: row.project_id,
      title: row.title ?? "",
      description: row.description ?? "",
      role: row.role,
      last_activity_at: Number(row.activity),
      pinned: !!row.pinned,
    }),
    (row) => Number(row.activity),
    (row) => row.project_id,
    view === "pinned" ? pins : undefined,
  );
}

export async function listCollaborationPeople(
  input: CollaborationQuery,
): Promise<CollaborationPage<CollaborationPerson>> {
  const q = query(input, "people");
  if (q.after) uuid(q.after.key, "person cursor");
  const { rows } = await getPool().query(
    `SELECT c.collaborator_account_id,left(c.display_name,256) AS display_name,
    (SELECT count(*)::integer FROM collaboration_access x ${ACCESS} WHERE x.account_id=$1::uuid AND ${VISIBLE}
      AND p.users_summary #>> ARRAY[c.collaborator_account_id::text,'group'] IN ('owner','collaborator')
      AND ($2::uuid IS NULL OR x.project_id=$2)) AS common_project_count
    FROM account_collaborator_index c WHERE c.account_id=$1::uuid AND c.collaborator_account_id<>$1::uuid
    AND ($3::uuid IS NULL OR c.collaborator_account_id=$3)
    AND ($4='' OR to_tsvector('simple',COALESCE(c.display_name,'')) @@ plainto_tsquery('simple',$4))
    AND ($5::uuid IS NULL OR c.collaborator_account_id>$5)
    AND EXISTS(SELECT 1 FROM collaboration_access x ${ACCESS} WHERE x.account_id=$1::uuid AND ${VISIBLE}
      AND p.users_summary #>> ARRAY[c.collaborator_account_id::text,'group'] IN ('owner','collaborator')
      AND ($2::uuid IS NULL OR x.project_id=$2))
    ORDER BY c.collaborator_account_id LIMIT $6`,
    [
      q.account_id,
      q.project_id ?? null,
      q.person_id ?? null,
      q.search,
      q.after?.key ?? null,
      q.limit + 1,
    ],
  );
  return page(
    rows,
    q,
    (row) => ({
      account_id: row.collaborator_account_id,
      display_name: row.display_name ?? "",
      common_project_count: row.common_project_count,
    }),
    () => 0,
    (row) => row.collaborator_account_id,
  );
}

export async function getCollaborationPersonalState(
  account_id: string,
  target: CollaborationTarget,
) {
  uuid(account_id, "account_id");
  validateTarget(target);
  const row = (
    await getPool().query(
      "SELECT * FROM collaboration_personal WHERE account_id=$1 AND entry_key=$2",
      [account_id, entryKey(target)],
    )
  ).rows[0];
  return personal(row);
}
export async function setCollaborationPersonalState(
  account_id: string,
  target: CollaborationTarget,
  patch: Partial<CollaborationPersonalState>,
  current: CollaborationResource,
) {
  uuid(account_id, "account_id");
  validateTarget(target);
  if (
    !(
      target.kind === "conversation" ||
      (target.kind === "agent" && !current.agent_id)
    ) &&
    (patch?.alias !== undefined || patch?.collected !== undefined)
  )
    throw Error("Use the existing agent/Library personal state adapter");
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw Error("invalid personal state patch");
  for (const key of Object.keys(patch))
    if (
      !["alias", "collected", "following", "muted", "read_through"].includes(
        key,
      )
    )
      throw Error("invalid personal state field");
  if (patch.alias !== undefined) boundedText(patch.alias, "alias", 128, true);
  for (const field of ["collected", "following", "muted"] as const)
    if (patch[field] !== undefined && typeof patch[field] !== "boolean")
      throw Error(`invalid ${field}`);
  if (patch.read_through !== undefined) {
    integer(patch.read_through, "read_through");
    if (patch.read_through > current.activity)
      throw Error("read marker exceeds current source activity");
  }
  return withAccountRehomeWriteFence({
    account_id,
    action: "update collaboration personal state",
    fn: async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `collaboration-account:${account_id}`,
      ]);
      const key = entryKey(target);
      await db.query(
        "SELECT 1 FROM collaboration_access WHERE account_id=$1 AND project_id=$2 FOR UPDATE",
        [account_id, target.project_id],
      );
      const previous = (
        await db.query(
          "SELECT * FROM collaboration_personal WHERE account_id=$1 AND entry_key=$2",
          [account_id, key],
        )
      ).rows[0];
      const state = {
        ...personal(previous),
        ...patch,
        read_through: Math.max(
          Number(previous?.read_through ?? 0),
          patch.read_through ?? 0,
        ),
      };
      const retained = (row: any) =>
        !!row &&
        !!(
          row.alias ||
          row.collected ||
          row.following ||
          row.muted ||
          row.following_explicit ||
          row.muted_explicit ||
          !row.attention_generation
        );
      if (
        !retained(previous) &&
        retained({
          ...previous,
          ...state,
          following_explicit:
            previous?.following_explicit || patch.following !== undefined,
          muted_explicit: previous?.muted_explicit || patch.muted !== undefined,
        }) &&
        Number(
          (
            await db.query(
              `SELECT count(*) AS n FROM collaboration_personal WHERE account_id=$1 AND ${RETAIN_PERSONAL_CHOICE}`,
              [account_id],
            )
          ).rows[0].n,
        ) >= 10000
      )
        throw Error("personal resource limit exceeded");
      await db.query(
        `INSERT INTO collaboration_personal(account_id,entry_key,project_id,alias,collected,following,muted,read_through,following_explicit,muted_explicit)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id,entry_key) DO UPDATE SET
      alias=excluded.alias,collected=excluded.collected,following=excluded.following,muted=excluded.muted,read_through=excluded.read_through,
      following_explicit=collaboration_personal.following_explicit OR excluded.following_explicit,
      muted_explicit=collaboration_personal.muted_explicit OR excluded.muted_explicit`,
        [
          account_id,
          key,
          target.project_id,
          state.alias || null,
          state.collected,
          state.following,
          state.muted,
          state.read_through,
          patch.following !== undefined,
          patch.muted !== undefined,
        ],
      );
      await db.query(
        "UPDATE collaboration_index SET search_text=(metadata->>'title') || ' ' || $3 WHERE account_id=$1 AND entry_key=$2",
        [account_id, key, state.alias ?? ""],
      );
      return personal(state);
    },
  });
}
