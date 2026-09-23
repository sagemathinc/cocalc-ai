const mockAccess = jest.fn();
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  assertProjectCollaboratorAccessAllowRemote: (...args) => mockAccess(...args),
}));
import { before, after, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import {
  createTestAccount,
  createTestMembershipPackage,
} from "../purchases/test-data";
import { linkCourseMembershipPackage } from "./packages";

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("course package linking", () => {
  let account_id: string, package_id: string, original: string;
  beforeEach(async () => {
    account_id = uuid();
    original = uuid();
    await createTestAccount(account_id);
    package_id = await createTestMembershipPackage({
      owner_account_id: account_id,
      kind: "course",
      membership_class: "student",
      seat_count: 100,
      expires_at: new Date("2030-01-28"),
      metadata: { course_project_id: original, course_title: "Original" },
    });
    mockAccess.mockReset().mockResolvedValue(undefined);
  });
  async function read() {
    return (
      await getPool().query("SELECT * FROM membership_packages WHERE id=$1", [
        package_id,
      ])
    ).rows[0];
  }
  it("preserves terms and links, and is idempotent", async () => {
    const course_project_id = uuid();
    const prior = await read();
    for (let i = 0; i < 2; i++)
      await linkCourseMembershipPackage({
        account_id,
        package_id,
        course_project_id,
      });
    const next = await read();
    expect(next.metadata).toEqual({
      ...prior.metadata,
      course_project_ids: [original, course_project_id],
    });
    for (const field of [
      "seat_count",
      "expires_at",
      "starts_at",
      "purchase_id",
    ])
      expect(next[field]).toEqual(prior[field]);
    expect(mockAccess).toHaveBeenCalledWith({
      account_id,
      project_id: course_project_id,
      warmRoute: false,
    });
  });
  it("rejects nonowners and project access denial without changes", async () => {
    const prior = await read();
    await expect(
      linkCourseMembershipPackage({
        account_id: uuid(),
        package_id,
        course_project_id: uuid(),
      }),
    ).rejects.toThrow("must own");
    expect(mockAccess).not.toHaveBeenCalled();
    mockAccess.mockRejectedValue(new Error("not a collaborator"));
    await expect(
      linkCourseMembershipPackage({
        account_id,
        package_id,
        course_project_id: uuid(),
      }),
    ).rejects.toThrow("not a collaborator");
    expect(await read()).toEqual(prior);
  });
  it("rejects non-course packages", async () => {
    await getPool().query(
      "UPDATE membership_packages SET kind='team' WHERE id=$1",
      [package_id],
    );
    await expect(
      linkCourseMembershipPackage({
        account_id,
        package_id,
        course_project_id: uuid(),
      }),
    ).rejects.toThrow("only course");
  });
  it("checks project access without holding the package row lock", async () => {
    mockAccess.mockImplementation(async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT id FROM membership_packages WHERE id=$1 FOR UPDATE NOWAIT",
          [package_id],
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
    await expect(
      linkCourseMembershipPackage({
        account_id,
        package_id,
        course_project_id: uuid(),
      }),
    ).resolves.toBeUndefined();
  });
  it("rejects malformed identifiers before authorization", async () => {
    await expect(
      linkCourseMembershipPackage({
        account_id,
        package_id,
        course_project_id: "bad",
      }),
    ).rejects.toThrow("valid");
    expect(mockAccess).not.toHaveBeenCalled();
  });
});
