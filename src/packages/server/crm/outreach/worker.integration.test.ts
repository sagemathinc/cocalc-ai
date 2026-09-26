/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import type * as OutreachStore from "./store";
import type * as OutreachWorker from "./worker";

const describePglite =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const CRM_TABLES = [
  "crm_organizations",
  "crm_people",
  "crm_person_emails",
  "crm_organization_people",
  "crm_opportunities",
  "crm_tasks",
  "crm_activities",
  "crm_mutation_events",
  "crm_outreach_templates",
  "crm_outreach_batches",
  "crm_outreach_deliveries",
  "crm_contact_suppressions",
  "crm_outreach_provider_operations",
  "crm_outreach_worker_state",
] as const;

const baseConfig = {
  enabled: true,
  delivery_enabled: true,
  webhook_enabled: false,
  send_per_minute: 100,
  send_per_hour: 100,
  send_per_day: 100,
  send_per_domain_per_day: 100,
  contact_cooldown_days: 90,
  retry_max_attempts: 8,
  retry_base_seconds: 60,
  worker_batch_size: 10,
};

interface Fixture {
  organizationId: string;
  personId: string;
  emailId: string;
  batchId: string;
  deliveryId: string;
}

describePglite("CRM outreach initial-send claim revalidation", () => {
  const originalEnv = {
    COCALC_BAY_ID: process.env.COCALC_BAY_ID,
    COCALC_CLUSTER_SEED_BAY_ID: process.env.COCALC_CLUSTER_SEED_BAY_ID,
    COCALC_DB: process.env.COCALC_DB,
    COCALC_PGLITE_DATA_DIR: process.env.COCALC_PGLITE_DATA_DIR,
  };
  let pool: Awaited<
    ReturnType<(typeof import("@cocalc/database/pool"))["default"]>
  >;
  let worker: typeof OutreachWorker;
  let config = { ...baseConfig };

  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "crm-outreach-test-seed";
    process.env.COCALC_CLUSTER_SEED_BAY_ID = "crm-outreach-test-seed";
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
    const store = (await import("./store")) as typeof OutreachStore;
    jest
      .spyOn(store, "loadOutreachConfiguration")
      .mockImplementation(async () => config);
    worker = await import("./worker");
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    const { closePglite } = await import("@cocalc/database/pglite");
    await closePglite();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(async () => {
    config = { ...baseConfig };
    await pool.query(
      `TRUNCATE TABLE
        crm_outreach_provider_operations,crm_contact_suppressions,
        crm_outreach_deliveries,crm_outreach_batches,crm_outreach_worker_state,
        crm_activities,crm_tasks,crm_opportunities,crm_organization_people,
        crm_person_emails,crm_people,crm_organizations CASCADE`,
    );
  });

  async function createFixture(
    options: {
      kind?: "adoption_pilot" | "renewal" | "expansion" | "other";
      state?: "queued" | "notification_requested";
      overrideReason?: string | null;
      normalizedEmail?: string;
      notificationRequestedAt?: Date | null;
    } = {},
  ): Promise<Fixture> {
    const actor = randomUUID();
    const organizationId = randomUUID();
    const personId = randomUUID();
    const emailId = randomUUID();
    const batchId = randomUUID();
    const deliveryId = randomUUID();
    const kind = options.kind ?? "adoption_pilot";
    const normalizedEmail = options.normalizedEmail ?? "person@example.com";
    await pool.query(
      `INSERT INTO crm_organizations
        (id,customer_number,display_name,organization_type,lifecycle_stage,
         created_by_account_id,updated_by_account_id)
       VALUES($1,$2,'Synthetic Organization','company','prospect',$3,$3)`,
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
      [emailId, personId, normalizedEmail],
    );
    await pool.query(
      `INSERT INTO crm_organization_people
        (id,organization_id,person_id,roles,state)
       VALUES($1,$2,$3,'{}','active')`,
      [randomUUID(), organizationId, personId],
    );
    await pool.query(
      `INSERT INTO crm_outreach_batches
        (id,outreach_number,name,purpose,kind,state,owner_account_id,
         created_by_account_id,updated_by_account_id,queued_at)
       VALUES($1,$2,'Synthetic batch','Synthetic eligibility test',$3,'queued',$4,$4,$4,NOW())`,
      [batchId, `OUT-TEST-${randomUUID()}`, kind, actor],
    );
    await pool.query(
      `INSERT INTO crm_outreach_deliveries
        (id,batch_id,organization_id,person_id,person_email_id,kind,
         recipient_name,normalized_email,recipient_domain,subject,
         body_plain_text,body_markdown,rendered_html,footer,state,
         provider_external_id,follow_up_policy,follow_up_after_days,
         max_followups,final_review_after_days,next_attempt_at,
         opt_out_token_digest,override_reason,notification_requested_at,
         created_by_account_id,approved_by_account_id,updated_by_account_id,
         approved_at,queued_at)
       VALUES($1,$2,$3,$4,$5,$6,'Synthetic Person',$7,'example.com',
         'Reviewed subject','Reviewed body','Reviewed body','<p>Reviewed body</p>',
         'Postal address and /crm/outreach/opt-out/token',$8,$9,'none',1,0,1,
         NOW(),repeat('a',64),$10,$11,$12,$12,$12,NOW(),NOW())`,
      [
        deliveryId,
        batchId,
        organizationId,
        personId,
        emailId,
        kind,
        normalizedEmail,
        options.state ?? "queued",
        `outreach-test-${deliveryId}`,
        options.overrideReason ?? null,
        options.notificationRequestedAt ?? null,
        actor,
      ],
    );
    return { organizationId, personId, emailId, batchId, deliveryId };
  }

  async function expectFailed(
    deliveryId: string,
    reason: string,
  ): Promise<void> {
    await expect(worker.__test__.claimOneEffectful()).resolves.toBeUndefined();
    const delivery = await pool.query(
      "SELECT state,last_error,next_attempt_at FROM crm_outreach_deliveries WHERE id=$1",
      [deliveryId],
    );
    expect(delivery.rows[0]).toMatchObject({
      state: "failed",
      last_error: expect.stringContaining(reason),
    });
    expect(delivery.rows[0].next_attempt_at).toBeInstanceOf(Date);
    const operations = await pool.query(
      "SELECT count(*)::int AS count FROM crm_outreach_provider_operations WHERE delivery_id=$1",
      [deliveryId],
    );
    expect(operations.rows[0].count).toBe(0);
  }

  it("fails an archived organization at claim time", async () => {
    const fixture = await createFixture();
    await pool.query(
      "UPDATE crm_organizations SET status='archived' WHERE id=$1",
      [fixture.organizationId],
    );
    await expectFailed(fixture.deliveryId, "organization_inactive");
  });

  it("fails a demoted primary email and an active suppression", async () => {
    const fixture = await createFixture();
    await pool.query(
      "UPDATE crm_person_emails SET is_primary=FALSE WHERE id=$1",
      [fixture.emailId],
    );
    await pool.query(
      `INSERT INTO crm_contact_suppressions
        (id,scope,normalized_scope_value,person_email_id,reason,source)
       VALUES($1,'email','person@example.com',$2,'manual','admin_ui')`,
      [randomUUID(), fixture.emailId],
    );
    await expectFailed(fixture.deliveryId, "email_not_primary,suppressed");
  });

  it("honors only a reviewed override for contact cooldown", async () => {
    await createFixture({
      kind: "renewal",
      state: "notification_requested",
      notificationRequestedAt: new Date(),
    });
    const blocked = await createFixture({ kind: "adoption_pilot" });
    await expectFailed(
      blocked.deliveryId,
      "contact_cooldown_active_no_override",
    );

    const allowed = await createFixture({
      kind: "expansion",
      overrideReason: "Reviewer accepted the recent-contact warning",
    });
    await expect(worker.__test__.claimOneEffectful()).resolves.toMatchObject({
      delivery: { id: allowed.deliveryId, state: "creating_ticket" },
      operation: "create_ticket",
    });
  });

  it("serializes same-kind duplicates so exactly one is claimable", async () => {
    const first = await createFixture({ kind: "other" });
    const second = await createFixture({ kind: "other" });
    const claim = await worker.__test__.claimOneEffectful();
    expect(claim).toMatchObject({ operation: "create_ticket" });
    const rows = await pool.query(
      `SELECT id,state,last_error FROM crm_outreach_deliveries
        WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[first.deliveryId, second.deliveryId]],
    );
    expect(rows.rows.map((row) => row.state).sort()).toEqual([
      "creating_ticket",
      "failed",
    ]);
    expect(
      rows.rows.find((row) => row.state === "failed")?.last_error,
    ).toContain("same_kind_nonterminal_duplicate");
  });

  it("allows different kinds for one email but rejects a later same-kind duplicate", async () => {
    const adoption = await createFixture({ kind: "adoption_pilot" });
    const renewal = await createFixture({ kind: "renewal" });

    const first = await worker.__test__.claimOneEffectful();
    const second = await worker.__test__.claimOneEffectful();
    expect(new Set([first?.delivery.id, second?.delivery.id])).toEqual(
      new Set([adoption.deliveryId, renewal.deliveryId]),
    );

    const duplicate = await createFixture({ kind: "adoption_pilot" });
    await expectFailed(duplicate.deliveryId, "same_kind_nonterminal_duplicate");
  });

  it("revalidates a started claim before any provider request", async () => {
    const fixture = await createFixture();
    const claim = await worker.__test__.claimOneEffectful();
    expect(claim).toMatchObject({ delivery: { id: fixture.deliveryId } });
    await pool.query(
      "UPDATE crm_organizations SET status='archived' WHERE id=$1",
      [fixture.organizationId],
    );

    await expect(
      worker.__test__.revalidateStartedCreateTicketClaim(claim!),
    ).resolves.toBe(false);
    const operation = await pool.query(
      "SELECT state,provider_status,error_category FROM crm_outreach_provider_operations WHERE id=$1",
      [claim!.operation_id],
    );
    expect(operation.rows[0]).toMatchObject({
      state: "cancelled",
      provider_status: "cancelled_preflight",
      error_category: "ineligible_initial_send",
    });
    const delivery = await pool.query(
      "SELECT state,last_error FROM crm_outreach_deliveries WHERE id=$1",
      [fixture.deliveryId],
    );
    expect(delivery.rows[0]).toMatchObject({
      state: "failed",
      last_error: expect.stringContaining("organization_inactive"),
    });
  });

  it("requeues a claim when delivery is disabled before provider work", async () => {
    const fixture = await createFixture();
    const claim = await worker.__test__.claimOneEffectful();
    expect(claim).toBeDefined();
    config = { ...config, delivery_enabled: false };

    await expect(
      worker.__test__.revalidateStartedCreateTicketClaim(claim!),
    ).resolves.toBe(false);
    const operation = await pool.query(
      "SELECT state,provider_status FROM crm_outreach_provider_operations WHERE id=$1",
      [claim!.operation_id],
    );
    expect(operation.rows[0]).toMatchObject({
      state: "cancelled",
      provider_status: "delivery_disabled",
    });
    const delivery = await pool.query(
      "SELECT state,provider_submitted_at FROM crm_outreach_deliveries WHERE id=$1",
      [fixture.deliveryId],
    );
    expect(delivery.rows[0]).toMatchObject({
      state: "queued",
      provider_submitted_at: null,
    });
  });

  it("requeues a started claim when its batch is paused", async () => {
    const fixture = await createFixture();
    const claim = await worker.__test__.claimOneEffectful();
    expect(claim).toBeDefined();
    await pool.query(
      "UPDATE crm_outreach_batches SET state='paused' WHERE id=$1",
      [fixture.batchId],
    );

    await expect(
      worker.__test__.revalidateStartedCreateTicketClaim(claim!),
    ).resolves.toBe(false);
    const operation = await pool.query(
      "SELECT state,provider_status FROM crm_outreach_provider_operations WHERE id=$1",
      [claim!.operation_id],
    );
    expect(operation.rows[0]).toMatchObject({
      state: "cancelled",
      provider_status: "batch_paused",
    });
    const delivery = await pool.query(
      "SELECT state,provider_submitted_at FROM crm_outreach_deliveries WHERE id=$1",
      [fixture.deliveryId],
    );
    expect(delivery.rows[0]).toMatchObject({
      state: "queued",
      provider_submitted_at: null,
    });
  });

  it("cancels a started claim when its batch is cancelled", async () => {
    const fixture = await createFixture();
    const claim = await worker.__test__.claimOneEffectful();
    expect(claim).toBeDefined();
    await pool.query(
      "UPDATE crm_outreach_batches SET state='cancelled' WHERE id=$1",
      [fixture.batchId],
    );

    await expect(
      worker.__test__.revalidateStartedCreateTicketClaim(claim!),
    ).resolves.toBe(false);
    const operation = await pool.query(
      "SELECT state,provider_status FROM crm_outreach_provider_operations WHERE id=$1",
      [claim!.operation_id],
    );
    expect(operation.rows[0]).toMatchObject({
      state: "cancelled",
      provider_status: "batch_cancelled",
    });
    const delivery = await pool.query(
      "SELECT state,cancelled_at FROM crm_outreach_deliveries WHERE id=$1",
      [fixture.deliveryId],
    );
    expect(delivery.rows[0]).toMatchObject({
      state: "cancelled",
      cancelled_at: expect.any(Date),
    });
  });
});
