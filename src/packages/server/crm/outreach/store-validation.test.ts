/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  batchRow,
  canQueueOutreachBatch,
  deliveryRow,
  missingRequiredMergeFields,
  outreachProviderConfigurationErrors,
  requireOutreachOptOutSecret,
} from "./store";

describe("CRM outreach database row decoding", () => {
  it("rejects undecoded PostgreSQL composite strings", () => {
    expect(() => deliveryRow("(id,queued,0)")).toThrow(
      "CRM outreach delivery row must be a decoded database record",
    );
    expect(() => batchRow("(id,OUT-1,queued)")).toThrow(
      "CRM outreach batch row must be a decoded database record",
    );
  });
});

describe("CRM outreach reviewed-content validation", () => {
  it("identifies blank required merge values", () => {
    expect(
      missingRequiredMergeFields(
        [
          "person.first_name",
          "opportunity.expected_value",
          "opportunity.service_starts_at",
        ],
        {
          "person.first_name": "Ada",
          "opportunity.expected_value": " ",
        },
      ),
    ).toEqual(["opportunity.expected_value", "opportunity.service_starts_at"]);
  });

  it("allows durable queueing independently of the delivery kill switch", () => {
    expect(canQueueOutreachBatch(true, "approved")).toBe(true);
    expect(canQueueOutreachBatch(false, "approved")).toBe(false);
    expect(canQueueOutreachBatch(true, "draft")).toBe(false);
  });

  it("reports every provider prerequisite without exposing secrets", () => {
    expect(outreachProviderConfigurationErrors({})).toEqual([
      "shared Zendesk support address is not configured",
      "Zendesk submitter ID is not configured",
      "Zendesk group ID is not configured",
      "company postal address is not configured",
      "reviewed outreach footer is not configured",
      "webhook/opt-out secret is not configured",
    ]);
    expect(
      outreachProviderConfigurationErrors({
        support_address: "partnerships@example.com",
        submitter_id: "1",
        group_id: "2",
        postal_address: "Example address",
        footer_markdown: "Best wishes",
        webhook_secret: "configured-but-never-returned",
      }),
    ).toEqual([]);
  });

  it("requires an opt-out secret before recipient content is created", () => {
    expect(() => requireOutreachOptOutSecret()).toThrow(
      "webhook/opt-out secret must be configured before adding outreach recipients",
    );
    expect(() => requireOutreachOptOutSecret("  ")).toThrow(
      "webhook/opt-out secret must be configured before adding outreach recipients",
    );
    expect(requireOutreachOptOutSecret(" secret ")).toBe("secret");
  });
});
