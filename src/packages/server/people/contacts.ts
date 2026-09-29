/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHmac, randomUUID } from "node:crypto";
import { getSecretSettingsKey } from "@cocalc/database/settings/secret-settings";
import {
  encryptSecretSettingValue,
  decryptSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";
import { lower_email_address, is_valid_email_address } from "@cocalc/util/misc";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import type {
  PeopleContact,
  PeopleContactQuery,
  PeopleContactPage,
  EnsurePeopleContact,
} from "@cocalc/util/people-invitation-history";
import { bumpPeopleRevision, peopleRevision } from "./schema";
import type { PeopleDb } from "./schema";
import {
  uuid,
  pageLimit,
  peopleSearch,
  withPeopleAccount,
  encodePeopleCursor,
  decodePeopleCursor,
} from "./common";

const aad = (account_id: string) => `people_contacts.email:${account_id}`;
async function hydrateContactNames(items: PeopleContact[]) {
  const ids = [
    ...new Set(
      items
        .filter((c) => !c.display_label && c.linked_account_id)
        .map((c) => c.linked_account_id!),
    ),
  ];
  if (!ids.length) return;
  const names = new Map(
    (await getClusterAccountsByIds(ids)).map((a) => [
      a.account_id,
      displayNameFromAccount(a),
    ]),
  );
  for (const c of items)
    if (!c.display_label && c.linked_account_id)
      c.display_label = names.get(c.linked_account_id) || null;
}
export async function peopleContactLabel(
  account_id: string,
  row: { display_label?: string | null; email_ciphertext?: string | null },
): Promise<string | undefined> {
  return (
    row.display_label ||
    (row.email_ciphertext
      ? decryptSecretSettingValue(
          aad(account_id),
          row.email_ciphertext,
          await getSecretSettingsKey(),
        )
      : undefined)
  );
}
async function contact(row): Promise<PeopleContact> {
  return {
    person_id: row.person_id,
    account_id: row.account_id,
    display_label: row.display_label,
    email: row.email_ciphertext
      ? decryptSecretSettingValue(
          aad(row.account_id),
          row.email_ciphertext,
          await getSecretSettingsKey(),
        )
      : null,
    linked_account_id: row.linked_account_id,
    link_provenance: row.link_provenance,
    archived: row.archived,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
/** Caller holds the account rehome fence, only after durable invitation creation.
 * Email and explicit-account identities intentionally do not merge automatically.
 */
export async function ensurePeopleContactInTransaction(
  db: PeopleDb,
  opts: EnsurePeopleContact,
): Promise<PeopleContact> {
  const { account_id, recipient } = opts;
  uuid(account_id, "account_id");
  if (
    opts.display_label != null &&
    (typeof opts.display_label !== "string" || opts.display_label.length > 160)
  )
    throw Error("invalid contact label");
  let identity: string,
    encrypted: string | null = null,
    linked: string | null = null;
  if ("email" in recipient) {
    const email = lower_email_address(recipient.email.trim());
    if (email.length > 254 || !is_valid_email_address(email))
      throw Error("invalid contact email");
    const key = await getSecretSettingsKey();
    identity = `email:${createHmac("sha256", key).update(aad(account_id)).update("\0").update(email).digest("hex")}`;
    encrypted = encryptSecretSettingValue(aad(account_id), email, key);
  } else {
    uuid(recipient.account_id, "recipient account_id");
    linked = recipient.account_id.toLowerCase();
    identity = `account:${linked}`;
  }
  const inserted = await db.query(
    `INSERT INTO people_contacts(account_id,person_id,identity_key,display_label,email_ciphertext,linked_account_id,link_provenance)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,identity_key) DO NOTHING RETURNING *`,
    [
      account_id,
      randomUUID(),
      identity,
      opts.display_label ?? null,
      encrypted,
      linked,
      linked ? "explicit_account" : null,
    ],
  );
  if (inserted.rows.length) {
    if (!inserted.rows[0].display_label && linked) {
      const name = displayNameFromAccount(
        (await getClusterAccountsByIds([linked]))[0],
      );
      if (name) {
        inserted.rows[0].display_label = name.slice(0, 160);
        await db.query(
          "UPDATE people_contacts SET display_label=$3 WHERE account_id=$1 AND person_id=$2",
          [
            account_id,
            inserted.rows[0].person_id,
            inserted.rows[0].display_label,
          ],
        );
      }
    }
    await bumpPeopleRevision(db, account_id);
    return contact(inserted.rows[0]);
  }
  return contact(
    (
      await db.query(
        "SELECT * FROM people_contacts WHERE account_id=$1 AND identity_key=$2",
        [account_id, identity],
      )
    ).rows[0],
  );
}
export async function ensurePeopleContactLocal(opts: EnsurePeopleContact) {
  return withPeopleAccount(opts.account_id, (db) =>
    ensurePeopleContactInTransaction(db, opts),
  );
}
export async function getPeopleContactLocal({
  account_id,
  person_id,
}: {
  account_id: string;
  person_id: string;
}): Promise<PeopleContact | null> {
  uuid(person_id, "person_id");
  const result = await withPeopleAccount(account_id, async (db) => {
    const row = (
      await db.query(
        "SELECT * FROM people_contacts WHERE account_id=$1 AND person_id=$2",
        [account_id, person_id],
      )
    ).rows[0];
    return row ? contact(row) : null;
  });
  if (result) await hydrateContactNames([result]);
  return result;
}
export async function archivePeopleContactLocal({
  account_id,
  person_id,
  archived,
}: {
  account_id: string;
  person_id: string;
  archived: boolean;
}) {
  uuid(person_id, "person_id");
  if (typeof archived !== "boolean") throw Error("invalid archived flag");
  return withPeopleAccount(account_id, async (db) => {
    const result = await db.query(
      "UPDATE people_contacts SET archived=$3,updated_at=now() WHERE account_id=$1 AND person_id=$2 AND archived<>$3 RETURNING person_id",
      [account_id, person_id, archived],
    );
    if (result.rows.length) await bumpPeopleRevision(db, account_id);
  });
}
export async function listPeopleContactsLocal(
  opts: PeopleContactQuery,
): Promise<PeopleContactPage> {
  const limit = pageLimit(opts.limit);
  const search = peopleSearch(opts.search);
  const binding = JSON.stringify([
    "contacts",
    opts.account_id,
    !!opts.include_archived,
    !!opts.without_shared_projects,
    search,
  ]);
  const result = await withPeopleAccount(opts.account_id, async (db) => {
    let revision = await peopleRevision(db, opts.account_id);
    if (opts.without_shared_projects) {
      // Membership projections can change without a contact mutation. Bind the
      // continuation to the complete excluded identity set, not a loaded page.
      const excluded = (
        await db.query(
          `SELECT md5(COALESCE(string_agg(c.person_id::text,',' ORDER BY c.person_id),'')) AS revision
        FROM people_contacts c WHERE c.account_id=$1 AND EXISTS(SELECT 1 FROM account_collaborator_index a
          WHERE a.account_id=c.account_id AND a.collaborator_account_id=c.linked_account_id AND a.common_project_count>0)`,
          [opts.account_id],
        )
      ).rows[0].revision;
      revision += `:${excluded}`;
    }
    const cursor = await decodePeopleCursor(opts.cursor, binding, revision);
    const values: any[] = [opts.account_id];
    const where = ["c.account_id=$1"];
    if (!opts.include_archived) where.push("NOT c.archived");
    if (search) {
      values.push(search);
      const textParam = values.length;
      const normalized = lower_email_address(search);
      const identity = is_valid_email_address(normalized)
        ? `email:${createHmac("sha256", await getSecretSettingsKey())
            .update(aad(opts.account_id))
            .update("\0")
            .update(normalized)
            .digest("hex")}`
        : "";
      values.push(identity);
      where.push(
        `(strpos(lower(COALESCE(c.display_label,'')),lower($${textParam}))>0 OR c.identity_key=$${values.length})`,
      );
    }
    if (opts.without_shared_projects)
      where.push(`NOT EXISTS(SELECT 1 FROM account_collaborator_index a
      WHERE a.account_id=c.account_id AND a.collaborator_account_id=c.linked_account_id AND a.common_project_count>0)`);
    // The count is deliberately evaluated before applying the continuation.
    const total = Number(
      (
        await db.query(
          `SELECT count(*)::text AS total FROM people_contacts c WHERE ${where.join(" AND ")}`,
          values,
        )
      ).rows[0].total,
    );
    if (cursor) {
      values.push(cursor.after[0]);
      where.push(`c.person_id<$${values.length}::uuid`);
    }
    values.push(limit + 1);
    const rows = (
      await db.query(
        `SELECT c.* FROM people_contacts c WHERE ${where.join(" AND ")} ORDER BY c.person_id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    const more = rows.length > limit;
    const items = await Promise.all(rows.slice(0, limit).map(contact));
    return {
      items,
      total,
      revision,
      ...(more
        ? {
            next_cursor: await encodePeopleCursor(
              binding,
              revision,
              [items[items.length - 1].person_id],
              cursor?.expires,
            ),
          }
        : {}),
    };
  });
  await hydrateContactNames(result.items);
  return result;
}
