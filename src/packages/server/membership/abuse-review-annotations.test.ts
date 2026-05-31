/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args: any[]) => queryMock(...args),
  }),
}));

function mockSchemaQueries() {
  queryMock.mockImplementation(async (sql: string) => {
    if (
      sql.includes(
        "CREATE TABLE IF NOT EXISTS account_abuse_review_annotations",
      ) ||
      sql.includes(
        "CREATE INDEX IF NOT EXISTS account_abuse_review_annotations_",
      )
    ) {
      return { rows: [] };
    }
    throw new Error(`unhandled query: ${sql}`);
  });
}

describe("abuse review annotations", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock.mockReset();
    mockSchemaQueries();
  });

  it("requires a reason when creating an annotation", async () => {
    const { createAbuseReviewAnnotation } =
      await import("./abuse-review-annotations");
    await expect(
      createAbuseReviewAnnotation({
        account_id: "11111111-1111-4111-8111-111111111111",
        created_by: "22222222-2222-4222-8222-222222222222",
        reason: "   ",
      }),
    ).rejects.toThrow("reason is required");
  });

  it("creates a durable annotation with normalized fields", async () => {
    queryMock.mockImplementation(async (sql: string, params?: any[]) => {
      if (
        sql.includes(
          "CREATE TABLE IF NOT EXISTS account_abuse_review_annotations",
        ) ||
        sql.includes(
          "CREATE INDEX IF NOT EXISTS account_abuse_review_annotations_",
        )
      ) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO account_abuse_review_annotations")) {
        expect(params).toEqual([
          "11111111-1111-4111-8111-111111111111",
          "33333333-3333-4333-8333-333333333333",
          "cpu",
          "legitimate",
          "suppress",
          "legitimate number theory",
          { cpu_seconds: 3600 },
          "22222222-2222-4222-8222-222222222222",
          new Date("2026-08-01T00:00:00.000Z"),
        ]);
        return {
          rows: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              account_id: params?.[0],
              project_id: params?.[1],
              category: params?.[2],
              disposition: params?.[3],
              priority_adjustment: params?.[4],
              reason: params?.[5],
              evidence: params?.[6],
              created_by: params?.[7],
              created_at: "2026-05-31T00:00:00.000Z",
              expires_at: params?.[8],
            },
          ],
        };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { createAbuseReviewAnnotation } =
      await import("./abuse-review-annotations");
    const annotation = await createAbuseReviewAnnotation({
      account_id: "11111111-1111-4111-8111-111111111111",
      project_id: "33333333-3333-4333-8333-333333333333",
      category: "cpu",
      disposition: "legitimate",
      priority_adjustment: "suppress",
      reason: "legitimate number theory",
      evidence: { cpu_seconds: 3600 },
      created_by: "22222222-2222-4222-8222-222222222222",
      expires_at: "2026-08-01T00:00:00.000Z",
    });

    expect(annotation).toMatchObject({
      id: "44444444-4444-4444-8444-444444444444",
      disposition: "legitimate",
      priority_adjustment: "suppress",
      revoked_at: null,
    });
  });

  it("lists only active annotations when requested", async () => {
    queryMock.mockImplementation(async (sql: string, params?: any[]) => {
      if (
        sql.includes(
          "CREATE TABLE IF NOT EXISTS account_abuse_review_annotations",
        ) ||
        sql.includes(
          "CREATE INDEX IF NOT EXISTS account_abuse_review_annotations_",
        )
      ) {
        return { rows: [] };
      }
      if (sql.includes("SELECT *") && sql.includes("revoked_at IS NULL")) {
        expect(params).toEqual([
          "11111111-1111-4111-8111-111111111111",
          "cpu",
          10,
        ]);
        return { rows: [] };
      }
      throw new Error(`unhandled query: ${sql}`);
    });

    const { listAbuseReviewAnnotations } =
      await import("./abuse-review-annotations");
    await expect(
      listAbuseReviewAnnotations({
        account_id: "11111111-1111-4111-8111-111111111111",
        category: "cpu",
        active_only: true,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});
