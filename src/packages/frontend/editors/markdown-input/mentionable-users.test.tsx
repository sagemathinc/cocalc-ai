/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { parseArtifactMention } from "@cocalc/util/artifact-mentions";
import { parseCollaborationReference } from "@cocalc/util/collaboration-references";
import { parseAgentMention } from "@cocalc/util/agent-mentions";

const mockGetStore = jest.fn();
const mockUseNamedAgents = jest.fn();
let mockAllowAgentMentions = false;
const mockProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let mockArtifactNames: any[] = [];
let mockHumanOnly = false;
let mockCollaboratorsEnabled = true;
let mockAccountId = "22222222-2222-4222-8222-222222222222";
const mockListResources = jest.fn();
const mockResolveChatAlias = jest.fn();
jest.mock("@cocalc/frontend/chat/embedding-options", () => ({
  useChatEmbeddingOptions: () => ({ humanOnly: mockHumanOnly }),
}));
jest.mock("@cocalc/frontend/collaborators/reference-picker-api", () => ({
  referencePickerApi: () => ({
    listResources: (...args) => mockListResources(...args),
    resolveChatAlias: (...args) => mockResolveChatAlias(...args),
  }),
}));

jest.mock("@cocalc/frontend/agents/artifact-names", () => ({
  useArtifactNames: () => ({ names: mockArtifactNames }),
}));

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
    mockArtifactNames = [];
    mockHumanOnly = false;
    mockCollaboratorsEnabled = true;
    mockAccountId = bob;
    mockResolveChatAlias.mockReset().mockResolvedValue(null);
    mockListResources
      .mockReset()
      .mockResolvedValue({ items: [], coverage: "complete" });
    mockUseNamedAgents.mockReset();
    jest.mocked(useTypedRedux).mockReset();
    jest.mocked(useTypedRedux).mockImplementation(((store, key) => {
      if (store === "account" && key === "account_id") return mockAccountId;
      if (store === "customize" && key === "collaborators_enabled")
        return mockCollaboratorsEnabled;
      return undefined;
    }) as any);
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
    mockArtifactNames = [
      { name: "nb1", project_id, entry_id: "a".repeat(64), active: true },
      {
        name: "elsewhere",
        project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        entry_id: "b".repeat(64),
        active: true,
      },
    ];
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

  it("human @ completion includes people and deduplicated typed resources, not legacy agent targets", async () => {
    mockHumanOnly = true;
    mockAllowAgentMentions = true;
    mockStores(jest.fn().mockReturnValue("Same Person"));
    mockArtifactNames = [
      { name: "same", project_id, entry_id: "a".repeat(64), active: true },
    ];
    const resources = ["agent", "artifact", "conversation"].map((kind) => ({
      project_id,
      resource_id: "same-id",
      kind,
      title: "Shared work",
      personal: { alias: "same" },
    }));
    mockListResources.mockResolvedValue({
      items: [...resources, resources[0]],
      coverage: "complete",
    });
    const { result } = renderHook(() => useMentionableUsers("same"));
    await waitFor(() =>
      expect(
        result
          .current("same")
          .filter((item) => parseCollaborationReference(item.value)),
      ).toHaveLength(3),
    );
    const items = result.current("same");
    expect(items.some((item) => item.group === "People")).toBe(true);
    expect(
      items.some(
        (item) =>
          parseAgentMention(item.value) || parseArtifactMention(item.value),
      ),
    ).toBe(false);
    expect(
      items
        .filter((item) => parseCollaborationReference(item.value))
        .map((item) => parseCollaborationReference(item.value)!.target.kind),
    ).toEqual(["agent", "artifact", "conversation"]);
    expect(mockUseNamedAgents).toHaveBeenCalledWith(false);
    expect(mockListResources).toHaveBeenCalledTimes(2);
    expect(mockListResources).toHaveBeenCalledWith({
      search: "same",
      scope: "all",
      after: undefined,
      limit: 25,
    });
  });

  it("accepts directory display aliases and opaque IDs beyond legacy handle limits", async () => {
    mockStores(jest.fn().mockReturnValue("Person"));
    mockHumanOnly = true;
    const target = {
      project_id,
      resource_id: "agent-thread:" + "x".repeat(200),
      kind: "agent",
    };
    const alias = "Planning & \u00e9quipe " + "x".repeat(60);
    mockListResources.mockResolvedValue({
      items: [{ ...target, title: "Shared work", personal: { alias } }],
      coverage: "complete",
    });
    const { result } = renderHook(() => useMentionableUsers("planning"));
    await waitFor(() =>
      expect(
        result
          .current("planning")
          .map((row) => parseCollaborationReference(row.value))
          .filter(Boolean),
      ).toEqual([
        { version: 1, target, display_fallback: "Shared work", alias },
      ]),
    );
  });

  it("shows local chat aliases while the global search is still pending", async () => {
    mockStores(jest.fn().mockReturnValue("Person"));
    mockHumanOnly = true;
    mockListResources.mockImplementation(({ project_id: project }) =>
      project
        ? Promise.resolve({
            items: [
              {
                project_id,
                kind: "conversation",
                resource_id: "chat-1",
                title: "Planning",
                personal: { alias: "chat1" },
              },
            ],
            coverage: "complete",
          })
        : new Promise(() => {}),
    );
    const { result } = renderHook(() => useMentionableUsers("chat"));
    await waitFor(() =>
      expect(
        result
          .current("chat")
          .some(
            (item) =>
              parseCollaborationReference(item.value)?.alias === "chat1",
          ),
      ).toBe(true),
    );
    expect(
      result
        .current("chat")
        .some((item) => item.value === "collaboration-reference-loading"),
    ).toBe(true);
  });

  it("resolves exact chat aliases independently and clears them on account changes", async () => {
    mockStores(jest.fn().mockReturnValue("Person"));
    mockHumanOnly = true;
    mockListResources.mockImplementation(() => new Promise(() => {}));
    mockResolveChatAlias.mockResolvedValue({
      project_id,
      kind: "conversation",
      resource_id: "old-chat",
      title: "Older conversation",
      personal: { alias: "chat1" },
    });
    const { result, rerender } = renderHook(() => useMentionableUsers("chat1"));
    const aliases = () =>
      result
        .current("chat1")
        .map((item) => parseCollaborationReference(item.value)?.alias);
    await waitFor(() => expect(aliases()).toContain("chat1"));
    expect(mockResolveChatAlias).toHaveBeenCalledWith({ alias: "chat1" });
    mockResolveChatAlias.mockResolvedValue(null);
    mockAccountId = alice;
    rerender();
    expect(aliases()).not.toContain("chat1");
    await waitFor(() => expect(mockResolveChatAlias).toHaveBeenCalledTimes(2));
    expect(aliases()).not.toContain("chat1");
  });

  it.each(["closed", "agent", "disabled"])(
    "does not query the directory for %s completion",
    async (mode) => {
      mockStores(jest.fn().mockReturnValue("Person"));
      mockHumanOnly = mode !== "agent";
      mockAllowAgentMentions = mode === "agent";
      mockCollaboratorsEnabled = mode !== "disabled";
      renderHook(() =>
        useMentionableUsers(mode === "closed" ? undefined : "same"),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      expect(mockListResources).not.toHaveBeenCalled();
      expect(mockResolveChatAlias).not.toHaveBeenCalled();
    },
  );

  it("invalidates search/account results and replaces rather than accumulates pages", async () => {
    mockStores(jest.fn().mockReturnValue("Person"));
    mockHumanOnly = true;
    const item = {
      project_id,
      resource_id: "artifact:1",
      kind: "artifact",
      title: "First title",
    };
    mockListResources.mockImplementation(async ({ project_id, after }) =>
      project_id
        ? { items: [], coverage: "complete" }
        : after
          ? {
              items: [
                { ...item, resource_id: "artifact:2", title: "Second title" },
              ],
              coverage: "complete",
            }
          : { items: [item], next: "next", coverage: "complete" },
    );
    const { result, rerender } = renderHook(
      ({ search }) => useMentionableUsers(search),
      { initialProps: { search: "title" } },
    );
    await waitFor(() =>
      expect(
        result
          .current("title")
          .some((row) => row.value === "collaboration-reference-next"),
      ).toBe(true),
    );
    act(() =>
      result
        .current("title")
        .find((row) => row.value === "collaboration-reference-next")!
        .onSelect!(),
    );
    await waitFor(() =>
      expect(mockListResources).toHaveBeenLastCalledWith(
        expect.objectContaining({ after: "next" }),
      ),
    );
    await waitFor(() =>
      expect(
        result
          .current("title")
          .filter((row) => parseCollaborationReference(row.value))
          .map(
            (row) => parseCollaborationReference(row.value)!.target.resource_id,
          ),
      ).toEqual(["artifact:2"]),
    );
    let resolve!: (page: unknown) => void;
    mockListResources.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    rerender({ search: "old" });
    expect(
      result
        .current("old")
        .some((row) => parseCollaborationReference(row.value)),
    ).toBe(false);
    await waitFor(() =>
      expect(mockListResources).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "old", after: undefined }),
      ),
    );
    mockAccountId = "another-viewer";
    mockListResources.mockResolvedValue({ items: [], coverage: "complete" });
    rerender({ search: "new" });
    await act(async () => resolve({ items: [item], coverage: "complete" }));
    expect(
      result
        .current("new")
        .some((row) => parseCollaborationReference(row.value)),
    ).toBe(false);
  });
});
