/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  cancelIneligibleQueuedFollowups,
  failIneligibleInitialSend,
  observeCreateTicketAbsence,
  reclaimStaleWebhookEvents,
  recoverExpiredProviderOperations,
} from "./worker";
import {
  loadOutreachRecipientEligibility,
  outreachInitialSendIneligibility,
  type OutreachRecipientEligibility,
} from "./store";

function queryResult(rowCount: number) {
  return { rows: Array.from({ length: rowCount }, () => ({})), rowCount };
}

describe("CRM outreach worker recovery invariants", () => {
  it("reports every recipient rule that drifted after review", () => {
    const eligibility: OutreachRecipientEligibility = {
      person_active: false,
      organization_active: false,
      relationship_active: false,
      email_verified: false,
      email_primary: false,
      suppression_reasons: ["manual"],
      cooldown_last_contact: new Date("2026-09-16T12:00:00.000Z"),
      same_kind_nonterminal_count: 1,
    };

    expect(outreachInitialSendIneligibility(eligibility, null)).toEqual([
      "person_inactive",
      "organization_inactive",
      "relationship_inactive",
      "email_unverified",
      "email_not_primary",
      "suppressed",
      "same_kind_nonterminal_duplicate",
      "contact_cooldown_active_no_override",
    ]);
    expect(
      outreachInitialSendIneligibility(eligibility, "reviewed exception"),
    ).not.toContain("contact_cooldown_active_no_override");
  });

  it("loads recipient eligibility through the supplied transaction", async () => {
    const lastContact = new Date("2026-09-15T12:00:00.000Z");
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            person_status: "active",
            organization_status: "archived",
            relationship_state: "active",
            verified: true,
            is_primary: false,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ reason: "manual" }] })
      .mockResolvedValueOnce({ rows: [{ last_contact: lastContact }] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] });

    await expect(
      loadOutreachRecipientEligibility(
        { query } as any,
        {
          id: "delivery-1",
          organization_id: "organization-1",
          person_id: "person-1",
          person_email_id: "email-1",
          normalized_email: "person@example.com",
          kind: "partnership",
        } as any,
        90,
      ),
    ).resolves.toEqual({
      person_active: true,
      organization_active: false,
      relationship_active: true,
      email_verified: true,
      email_primary: false,
      suppression_reasons: ["manual"],
      cooldown_last_contact: lastContact,
      same_kind_nonterminal_count: 2,
    });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("fails an ineligible initial send without leaving it retryable", async () => {
    const query = jest.fn().mockResolvedValue(queryResult(1));
    const delivery = {
      id: "delivery-1",
      organization_id: "organization-1",
      person_id: "person-1",
      opportunity_id: null,
      task_id: null,
      zendesk_ticket_id: null,
      version: 7,
    } as any;

    await failIneligibleInitialSend(
      { query } as any,
      delivery,
      "before_provider",
      ["organization_inactive", "email_not_primary"],
    );

    expect(query.mock.calls[0][0]).toContain("state='failed'");
    expect(query.mock.calls[0][0]).not.toContain("next_attempt_at");
    expect(query.mock.calls[0][0]).toContain("provider_submitted_at=NULL");
    expect(query.mock.calls[0][1]).toEqual([
      "INELIGIBLE_BEFORE_PROVIDER:organization_inactive,email_not_primary",
      "delivery-1",
    ]);
  });

  it("moves expired effectful claims to indeterminate and safely requeues reads", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(queryResult(2))
      .mockResolvedValueOnce(queryResult(1));

    await expect(
      recoverExpiredProviderOperations({ query } as any),
    ).resolves.toEqual({
      effectful_indeterminate: 2,
      reconciliation_requeued: 1,
    });
    expect(query.mock.calls[0][0]).toContain("state='indeterminate'");
    expect(query.mock.calls[0][0]).toContain(
      "operation IN ('create_ticket','add_comment')",
    );
    expect(query.mock.calls[0][0]).toContain("lease_expires_at<NOW()");
    expect(query.mock.calls[1][0]).toContain("operation='reconcile_ticket'");
    expect(query.mock.calls[1][0]).toContain("state='queued'");
  });

  it("returns stale processing webhooks to the bounded retry queue", async () => {
    const query = jest.fn().mockResolvedValue(queryResult(3));

    await expect(reclaimStaleWebhookEvents({ query } as any)).resolves.toBe(3);
    expect(query.mock.calls[0][0]).toContain("state='processing'");
    expect(query.mock.calls[0][0]).toContain("state='failed'");
    expect(query.mock.calls[0][0]).toContain("updated_at<NOW()");
    expect(query.mock.calls[0][1]).toEqual([120_000]);
  });

  it("cancels queued comments that became unsafe before claim", async () => {
    const query = jest.fn().mockResolvedValue(queryResult(4));

    await expect(
      cancelIneligibleQueuedFollowups(8, { query } as any),
    ).resolves.toBe(4);
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("p.operation='add_comment'");
    expect(sql).toContain("p.state='queued'");
    expect(sql).toContain("d.replied_at IS NOT NULL");
    expect(sql).toContain("d.follow_up_attempt_count>=d.max_followups");
    expect(sql).toContain("crm_contact_suppressions");
    expect(query.mock.calls[0][1]).toEqual([8]);
  });

  it("requires repeated absence observations across the grace window", () => {
    const start = Date.parse("2026-08-26T12:00:00.000Z");
    const first = observeCreateTicketAbsence({}, start);
    const second = observeCreateTicketAbsence(
      first.request_payload,
      start + 60_000,
    );
    const third = observeCreateTicketAbsence(
      second.request_payload,
      start + 4 * 60_000,
    );
    const afterGrace = observeCreateTicketAbsence(
      third.request_payload,
      start + 5 * 60_000,
    );

    expect(first.definitive).toBe(false);
    expect(second.definitive).toBe(false);
    expect(third.definitive).toBe(false);
    expect(afterGrace.definitive).toBe(true);
    expect(afterGrace.request_payload).toMatchObject({
      absence_first_observed_at: "2026-08-26T12:00:00.000Z",
      absence_last_observed_at: "2026-08-26T12:05:00.000Z",
      absence_observation_count: 4,
    });
  });
});
