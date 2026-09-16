/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import {
  batchRow,
  assertDraftOutreachRecipient,
  canQueueOutreachBatch,
  composeOutreachBody,
  decodeZendeskId,
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

  it("decodes Zendesk BIGINT identifiers without losing precision", () => {
    const zendeskCommentId = "48444142181645";
    expect(decodeZendeskId(zendeskCommentId, "comment_id", true)).toBe(
      48_444_142_181_645,
    );
    expect(
      deliveryRow({
        opening_zendesk_comment_id: zendeskCommentId,
        last_zendesk_comment_id: zendeskCommentId,
      }),
    ).toMatchObject({
      opening_zendesk_comment_id: 48_444_142_181_645,
      last_zendesk_comment_id: 48_444_142_181_645,
    });
  });

  it("rejects Zendesk identifiers outside the JavaScript safe range", () => {
    expect(() =>
      decodeZendeskId("9007199254740992", "comment_id", true),
    ).toThrow("comment_id must be a positive safe integer");
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

  it("preserves the exact reviewed footer when editing draft content", () => {
    const footer = "Postal address\n\nOpt out: https://example.test/token";
    expect(composeOutreachBody("Updated body", footer)).toBe(
      `Updated body\n\n${footer}`,
    );
  });

  it("does not double the footer when the body was copied from outreach show", () => {
    const footer =
      "Postal address\n\nTo stop receiving partnership outreach from CoCalc: https://example.test/crm/outreach/opt-out/token";
    const composed = composeOutreachBody(`Updated body\n\n${footer}\n`, footer);
    expect(composed).toBe(`Updated body\n\n${footer}`);
    expect(composed.split("/crm/outreach/opt-out/")).toHaveLength(2);
  });

  it("matches the footer in a body file saved with Windows line endings", () => {
    const footer =
      "Postal address\n\nTo stop receiving partnership outreach from CoCalc: https://example.test/crm/outreach/opt-out/token";
    expect(
      composeOutreachBody(
        `Updated body\r\n\r\n${footer.replace(/\n/g, "\r\n")}\r\n`,
        footer,
      ),
    ).toBe(`Updated body\n\n${footer}`);
  });

  it("refuses a body carrying an extra or altered opt-out link", () => {
    const footer =
      "Postal address\n\nTo stop receiving partnership outreach from CoCalc: https://example.test/crm/outreach/opt-out/token";
    expect(() =>
      composeOutreachBody(
        "Updated body\n\nUnsubscribe: https://example.test/crm/outreach/opt-out/other",
        footer,
      ),
    ).toThrow("body_markdown must not contain an opt-out link");
    expect(() =>
      composeOutreachBody(`Updated body\n\n${footer} Thanks again.`, footer),
    ).toThrow("body_markdown must not contain an opt-out link");
  });

  it("refuses a copied footer whose opt-out token was deleted", () => {
    const footer =
      "Postal address\n\nTo stop receiving partnership outreach from CoCalc: https://example.test/crm/outreach/opt-out/token";
    expect(() =>
      composeOutreachBody(
        "Updated body\n\nTo stop receiving partnership outreach from CoCalc: https://example.test/crm/outreach/opt-out/",
        footer,
      ),
    ).toThrow("body_markdown must not contain an opt-out link");
  });

  it("matches a footer configured with Windows line endings and keeps it verbatim", () => {
    const footer =
      "Postal address\r\n\r\nTo stop receiving partnership outreach from CoCalc: https://example.test/crm/outreach/opt-out/token";
    const copied = `Updated body\n\n${footer.replace(/\r\n/g, "\n")}`;
    expect(composeOutreachBody(copied, footer)).toBe(
      `Updated body\n\n${footer}`,
    );
  });

  it("refuses a body that is only the preserved footer", () => {
    const footer =
      "Postal address\n\nTo stop receiving partnership outreach from CoCalc: https://example.test/crm/outreach/opt-out/token";
    expect(() => composeOutreachBody(footer, footer)).toThrow(
      "body_markdown is required",
    );
  });

  it("applies the body limit after appending the preserved footer", () => {
    expect(() => composeOutreachBody("x".repeat(49_999), "footer")).toThrow(
      "including its required footer must be at most 50000 characters",
    );
  });

  it("rejects edits after either the batch or delivery leaves draft", () => {
    expect(() =>
      assertDraftOutreachRecipient("approved", "draft", "edited"),
    ).toThrow("only draft recipients can be edited");
    expect(() =>
      assertDraftOutreachRecipient("draft", "queued", "edited"),
    ).toThrow("only draft recipients can be edited");
    expect(() =>
      assertDraftOutreachRecipient("draft", "draft", "edited"),
    ).not.toThrow();
  });
});
