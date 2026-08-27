/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { SCHEMA } from "./types";
import "./crm-outreach";

describe("CRM outreach database schema", () => {
  it("stores Zendesk comment identifiers as 64-bit integers", () => {
    expect(
      SCHEMA.crm_outreach_deliveries.fields.opening_zendesk_comment_id,
    ).toMatchObject({ type: "integer", pg_type: "BIGINT" });
    expect(
      SCHEMA.crm_outreach_deliveries.fields.last_zendesk_comment_id,
    ).toMatchObject({ type: "integer", pg_type: "BIGINT" });
    expect(
      SCHEMA.crm_outreach_zendesk_events.fields.zendesk_comment_id,
    ).toMatchObject({ type: "integer", pg_type: "BIGINT" });
    expect(
      SCHEMA.crm_outreach_engagement_events.fields.zendesk_comment_id,
    ).toMatchObject({ type: "integer", pg_type: "BIGINT" });
  });
});
