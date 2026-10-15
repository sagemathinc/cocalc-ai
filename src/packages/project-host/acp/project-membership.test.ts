const rows = new Map<string, any>();

jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: (_table: string, pk: string) => rows.get(pk),
}));

import { isAcpProjectMember } from "./project-membership";

const project_id = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const collaborator = "33333333-3333-4333-8333-333333333333";
const removed = "44444444-4444-4444-8444-444444444444";

describe("isAcpProjectMember", () => {
  beforeEach(() => {
    rows.clear();
    rows.set(JSON.stringify({ project_id }), {
      project_id,
      users: {
        [owner]: { group: "owner" },
        [collaborator]: "collaborator",
      },
    });
  });

  it("accepts owners and collaborators on the local project record", () => {
    expect(isAcpProjectMember({ account_id: owner, project_id })).toBe(true);
    expect(isAcpProjectMember({ account_id: collaborator, project_id })).toBe(
      true,
    );
  });

  it("refuses removed accounts, unknown projects and malformed ids", () => {
    expect(isAcpProjectMember({ account_id: removed, project_id })).toBe(false);
    expect(
      isAcpProjectMember({
        account_id: owner,
        project_id: "55555555-5555-4555-8555-555555555555",
      }),
    ).toBe(false);
    expect(isAcpProjectMember({ account_id: "owner", project_id })).toBe(false);
  });
});
