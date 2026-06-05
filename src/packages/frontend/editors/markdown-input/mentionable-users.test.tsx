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

import { mentionableUsers } from "./mentionable-users";

describe("mentionableUsers", () => {
  const project_id = "project-1";
  const alice = "11111111-1111-4111-8111-111111111111";

  function mockStores(getName: jest.Mock) {
    const projectsStore = fromJS({
      project_map: {
        [project_id]: {
          users: {
            [alice]: {},
          },
          last_active: {
            [alice]: 1,
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

  it("omits unresolved users instead of showing account ids", () => {
    const getName = jest.fn().mockReturnValue(undefined);
    mockStores(getName);

    expect(mentionableUsers({ search: undefined, project_id })).toEqual([]);
    expect(getName).toHaveBeenCalledWith(alice);
  });

  it("uses resolved display names for mention labels and search", () => {
    mockStores(jest.fn().mockReturnValue("Ada Lovelace"));

    const items = mentionableUsers({ search: undefined, project_id });

    expect(items).toHaveLength(1);
    expect(items[0].value).toBe(alice);
    expect(items[0].search).toBe("ada lovelace");
  });
});
