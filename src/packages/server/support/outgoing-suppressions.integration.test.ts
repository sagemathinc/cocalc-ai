/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import type * as Suppressions from "./outgoing-suppressions";

const describePglite =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const CRM_TABLES = [
  "crm_organizations",
  "crm_people",
  "crm_person_emails",
  "crm_person_accounts",
  "crm_organization_people",
  "crm_contact_suppressions",
] as const;

describePglite("outgoing support ticket suppressions", () => {
  const originalEnv = {
    COCALC_BAY_ID: process.env.COCALC_BAY_ID,
    COCALC_CLUSTER_SEED_BAY_ID: process.env.COCALC_CLUSTER_SEED_BAY_ID,
    COCALC_DB: process.env.COCALC_DB,
    COCALC_PGLITE_DATA_DIR: process.env.COCALC_PGLITE_DATA_DIR,
  };
  const actor = randomUUID();
  let pool: Awaited<
    ReturnType<(typeof import("@cocalc/database/pool"))["default"]>
  >;
  let suppressions: typeof Suppressions;

  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "support-suppressions-test-seed";
    process.env.COCALC_CLUSTER_SEED_BAY_ID = "support-suppressions-test-seed";
    process.env.COCALC_DB = "pglite";
    process.env.COCALC_PGLITE_DATA_DIR = "memory://";
    const getPool = (await import("@cocalc/database/pool")).default;
    pool = getPool();
    const { SCHEMA } = await import("@cocalc/util/schema");
    const { schemaNeedsSync, syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    const crmSchema = Object.fromEntries(
      CRM_TABLES.map((name) => [name, SCHEMA[name]]),
    );
    await syncSchema(crmSchema);
    expect(await schemaNeedsSync(crmSchema)).toBe(false);
    suppressions = await import("./outgoing-suppressions");
  });

  afterAll(async () => {
    const { closePglite } = await import("@cocalc/database/pglite");
    await closePglite();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE TABLE crm_contact_suppressions,crm_organization_people,
        crm_person_accounts,crm_person_emails,crm_people,crm_organizations
        CASCADE`,
    );
  });

  // A CRM person in an organization, with one CRM email, linked to an account.
  async function person({
    email,
    accountId,
    accountState = "verified",
  }: {
    email: string;
    accountId: string;
    accountState?: string;
  }) {
    const organizationId = randomUUID();
    const personId = randomUUID();
    const emailId = randomUUID();
    await pool.query(
      `INSERT INTO crm_organizations
        (id,customer_number,display_name,organization_type,lifecycle_stage,
         created_by_account_id,updated_by_account_id)
       VALUES($1,$2,'Synthetic University','university','customer',$3,$3)`,
      [organizationId, `CRM-TEST-${randomUUID()}`, actor],
    );
    await pool.query(
      `INSERT INTO crm_people
        (id,display_name,created_by_account_id,updated_by_account_id)
       VALUES($1,'Synthetic Person',$2,$2)`,
      [personId, actor],
    );
    await pool.query(
      `INSERT INTO crm_person_emails
        (id,person_id,email_address,normalized_email,is_primary,verified)
       VALUES($1,$2,$3,$3,TRUE,TRUE)`,
      [emailId, personId, email],
    );
    await pool.query(
      `INSERT INTO crm_organization_people
        (id,organization_id,person_id,roles,state)
       VALUES($1,$2,$3,'{}','active')`,
      [randomUUID(), organizationId, personId],
    );
    await pool.query(
      `INSERT INTO crm_person_accounts(id,person_id,account_id,state)
       VALUES($1,$2,$3,$4)`,
      [randomUUID(), personId, accountId, accountState],
    );
    return { organizationId, personId, emailId };
  }

  async function suppress(
    scope: "email" | "person" | "organization" | "domain",
    value: string,
    reason: string,
    refs: {
      person_id?: string;
      organization_id?: string;
      person_email_id?: string;
    } = {},
  ) {
    await pool.query(
      `INSERT INTO crm_contact_suppressions
        (id,scope,normalized_scope_value,person_id,organization_id,
         person_email_id,reason,source)
       VALUES($1,$2,$3,$4,$5,$6,$7,'cli')`,
      [
        randomUUID(),
        scope,
        value,
        refs.person_id ?? null,
        refs.organization_id ?? null,
        refs.person_email_id ?? null,
        reason,
      ],
    );
  }

  it("finds person and organization suppressions through a verified account link when the account email is not a CRM email", async () => {
    const accountId = randomUUID();
    const { personId, organizationId } = await person({
      email: "old-address@uni.example",
      accountId,
    });
    await suppress("organization", organizationId, "legal", {
      organization_id: organizationId,
    });
    await suppress("person", personId, "manual", { person_id: personId });
    const current = "new-address@other.example";
    // Without the account, the current address alone matches nothing.
    await expect(
      suppressions.activeSuppressionReasons({ email: current }),
    ).resolves.toEqual([]);
    await expect(
      suppressions.activeSuppressionReasons({
        email: current,
        account_ids: [accountId],
      }),
    ).resolves.toEqual(["legal", "manual"]);
  });

  it("ignores account links that are not verified", async () => {
    const accountId = randomUUID();
    const { organizationId } = await person({
      email: "old-address@uni.example",
      accountId,
      accountState: "suggested",
    });
    await suppress("organization", organizationId, "legal", {
      organization_id: organizationId,
    });
    await expect(
      suppressions.activeSuppressionReasons({
        email: "new-address@other.example",
        account_ids: [accountId],
      }),
    ).resolves.toEqual([]);
  });

  it("matches the address, its domain and its email relation, but not the person's other addresses", async () => {
    const accountId = randomUUID();
    const { emailId } = await person({
      email: "lee@uni.example",
      accountId,
    });
    // A bounce on this exact CRM email relation applies to it...
    await suppress("email", "lee@uni.example", "hard_bounce", {
      person_email_id: emailId,
    });
    await suppress("domain", "uni.example", "complaint");
    await expect(
      suppressions.activeSuppressionReasons({ email: "lee@uni.example" }),
    ).resolves.toEqual(["complaint", "hard_bounce"]);
    // ...but not to another address of the same account and person.
    await expect(
      suppressions.activeSuppressionReasons({
        email: "lee@elsewhere.example",
        account_ids: [accountId],
      }),
    ).resolves.toEqual([]);
  });

  it("skips inactive suppressions", async () => {
    await suppress("email", "lee@uni.example", "legal");
    await pool.query("UPDATE crm_contact_suppressions SET active=FALSE");
    await expect(
      suppressions.activeSuppressionReasons({ email: "lee@uni.example" }),
    ).resolves.toEqual([]);
  });
});
