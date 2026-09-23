/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";
import { renderHook } from "@testing-library/react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { parseArtifactMention } from "@cocalc/util/artifact-mentions";
import { ARTIFACT_NAMES_SETTING } from "@cocalc/frontend/agents/artifact-names";

const mockGetStore = jest.fn();
const mockUseNamedAgents = jest.fn();
let mockAllowAgentMentions = false;
const mockProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
  useProjectContext: () => ({ project_id: mockProjectId }),
}));

jest.mock("@cocalc/frontend/agents/api", () => ({
  namedAgentReference: (agent) => ({
    version: 1,
    name: agent.name,
    target: agent.endpoint,
    naming_account_id: agent.account_id,
  }),
  useNamedAgents: (enabled) => mockUseNamedAgents(enabled),
  useAgentNetworks: () => ({
    directory: { networks: [], controls: { paused: false } },
  }),
}));

jest.mock("@cocalc/frontend/agents/mention-context", () => ({
  useAgentMentionContext: () => ({
    allowAgentMentions: mockAllowAgentMentions,
    states: {},
  }),
}));

import {
  ALL_PROJECT_COLLABORATORS_MENTION_ID,
  getMentionAllAccountIds,
  mentionDisplayText,
} from "./mention-all";
import { mentionableUsers, useMentionableUsers } from "./mentionable-users";

describe("mentionableUsers", () => {
  const project_id = mockProjectId;
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
    mockAllowAgentMentions = false;
    mockUseNamedAgents.mockReset();
    jest.mocked(useTypedRedux).mockReset();
    mockUseNamedAgents.mockReturnValue({
      directory: {
        enabled: true,
        agents: [
          {
            name: "illustrator",
            account_id: alice,
            endpoint: {
              project_id,
              agent_id: "44444444-4444-4444-8444-444444444444",
            },
            available: true,
          },
        ],
      },
    });
  });

  it("suggests only personally named artifacts in this project", () => {
    mockStores(jest.fn());
    mockAllowAgentMentions = true;
    jest.mocked(useTypedRedux).mockImplementation((store, key) =>
      store === "account" && key === "other_settings"
        ? (fromJS({
            [ARTIFACT_NAMES_SETTING]: JSON.stringify([
              {
                name: "nb1",
                project_id,
                entry_id: "a".repeat(64),
                active: true,
              },
              {
                name: "elsewhere",
                project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                entry_id: "b".repeat(64),
                active: true,
              },
            ]),
          }) as any)
        : undefined,
    );
    const { result } = renderHook(() => useMentionableUsers());
    const items = result.current("nb");
    expect(
      items.find((item) => item.group === "Artifacts")?.label,
    ).toBeTruthy();
    expect(
      parseArtifactMention(
        items.find((item) => item.group === "Artifacts")!.value,
      ),
    ).toEqual({
      version: 1,
      project_id,
      entry_id: "a".repeat(64),
      name: "nb1",
    });
    expect(items.some((item) => item.search === "elsewhere")).toBe(false);
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

  it("excludes named agents outside an agent thread", () => {
    mockStores(jest.fn().mockReturnValue("Ada Lovelace"));
    const { result } = renderHook(() => useMentionableUsers());

    const items = result.current(undefined);
    expect(items.map(({ group }) => group)).not.toContain("Agents");
    expect(mockUseNamedAgents).toHaveBeenCalledWith(false);
  });

  it("includes named agents when the agent thread opts in", () => {
    mockAllowAgentMentions = true;
    mockStores(jest.fn().mockReturnValue("Ada Lovelace"));
    const { result } = renderHook(() => useMentionableUsers());

    const items = result.current("illustrator");
    expect(items.map(({ group }) => group)).toContain("Other agents");
    expect(mockUseNamedAgents).toHaveBeenCalledWith(true);
  });
});
