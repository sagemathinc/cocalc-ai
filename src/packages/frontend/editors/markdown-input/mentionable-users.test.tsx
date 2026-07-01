/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";

const mockGetStore = jest.fn();

jest.mock("@cocalc/frontend/account/avatar/avatar", () => ({
  Avatar: () => null,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name: string) => mockGetStore(name),
  },
  useMemo: (fn: () => any) => fn(),
  useTypedRedux: jest.fn(),
}));

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ project_id: "project-1" }),
}));

import {
  ALL_PROJECT_COLLABORATORS_MENTION_ID,
  getMentionAllAccountIds,
  mentionDisplayText,
} from "./mention-all";
import { mentionableUsers } from "./mentionable-users";

describe("mentionableUsers", () => {
  const project_id = "project-1";
  const alice = "11111111-1111-4111-8111-111111111111";
  const bob = "22222222-2222-4222-8222-222222222222";
  const viewer = "33333333-3333-4333-8333-333333333333";

  function mockStores(getName: jest.Mock, users: Record<string, any> = {}) {
    const projectsStore = fromJS({
      project_map: {
        [project_id]: {
          users: Object.keys(users).length > 0 ? users : { [alice]: {} },
          last_active: {
            [alice]: 1,
            [bob]: 2,
            [viewer]: 3,
          },
        },
      },
    });
    mockGetStore.mockImplementation((name: string) => {
      if (name === "projects") return projectsStore;
      if (name === "account") {
        return fromJS({ account_id: "22222222-2222-4222-8222-222222222222" });
      }
      if (name === "users") {
        return { get_name: getName };
      }
      throw new Error(`unexpected store ${name}`);
    });
  }

  beforeEach(() => {
    mockGetStore.mockReset();
  });

  it("keeps unresolved collaborators visible while their names hydrate", () => {
    const getName = jest.fn().mockReturnValue(undefined);
    mockStores(getName);

    const items = mentionableUsers({ search: undefined, project_id });
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe(alice);
    expect(items[0].search).toContain(alice);
    expect(getName).toHaveBeenCalledWith(alice);
  });

  it("uses resolved display names for mention labels and search", () => {
    mockStores(jest.fn().mockReturnValue("Ada Lovelace"));

    const items = mentionableUsers({ search: undefined, project_id });

    expect(items).toHaveLength(1);
    expect(items[0].value).toBe(alice);
    expect(items[0].search).toContain("ada lovelace");
    expect(items[0].search).toContain(alice);
  });

  it("uses the subscribed user_map snapshot when the users store getter is stale", () => {
    const getName = jest.fn().mockReturnValue(undefined);
    mockStores(getName);

    const items = mentionableUsers({
      search: undefined,
      project_id,
      user_map: fromJS({
        [alice]: {
          first_name: "ws5",
          last_name: "User",
        },
      }),
    });

    expect(items).toHaveLength(1);
    expect(items[0].search).toContain("ws5 user");
    expect(getName).not.toHaveBeenCalled();
  });

  it("adds @all for other owner/collaborator users", () => {
    mockStores(
      jest.fn((account_id: string) => {
        if (account_id === alice) return "Ada Lovelace";
        if (account_id === bob) return "Bob Collaborator";
        if (account_id === viewer) return "Vera Viewer";
        return undefined;
      }),
      {
        [alice]: { group: "owner" },
        [bob]: { group: "collaborator" },
        [viewer]: { group: "viewer" },
      },
    );

    expect(getMentionAllAccountIds(project_id)).toEqual([alice]);

    const items = mentionableUsers({ search: undefined, project_id });
    expect(items[0].value).toBe(ALL_PROJECT_COLLABORATORS_MENTION_ID);
    expect(items[0].search).toContain("all");
  });

  it("displays the all-collaborators sentinel as @all", () => {
    expect(
      mentionDisplayText(ALL_PROJECT_COLLABORATORS_MENTION_ID, "@ignored"),
    ).toBe("@all");
    expect(mentionDisplayText(alice, "@Ada Lovelace")).toBe("@Ada Lovelace");
  });
});
