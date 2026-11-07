/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Quick Navigation on an older hub (no account-wide reads) starts the
// per-project catalog itself, without the Library page mounted.

import { act, renderHook } from "@testing-library/react";
import { useWorkspaceCandidates } from "./workspace-candidates";

const listProject = jest.fn(async ({ project_id }) => ({
  entries: [
    {
      entry_id: "e1",
      project_id,
      chat_path: "/a.chat",
      item: {
        thread_id: "t",
        artifact_id: "e1",
        kind: "file",
        title: "Old hub artifact",
        description: "",
        created_at: 1,
        publication: { operation_id: "o", message_id: "m" },
      },
    },
  ],
  indexed_sources: 1,
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        artifactCatalog: { listProject: (...a) => (listProject as any)(...a) },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/chat/use-artifact-pins", () => ({
  useArtifactPins: () => ({ pins: [] }),
}));
jest.mock("@cocalc/frontend/people/use-conversations", () => ({
  useConversations: () => ({ conversations: [] }),
}));
jest.mock("@cocalc/frontend/users/display-name", () => ({
  displayNameFromUserRecord: () => "",
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store: string, field: string) =>
    field === "account_id" ? "acct-quick-nav" : undefined,
}));

const agents = [
  {
    name: "helper",
    endpoint: { project_id: "p1", agent_id: "a" },
    path: "/a.chat",
    thread_id: "t",
  } as any,
];

test("closed: nothing; open on an older hub: the per-project catalog loads", async () => {
  const view = renderHook(
    ({ enabled }) => useWorkspaceCandidates(agents, enabled),
    {
      initialProps: { enabled: false },
    },
  );
  await act(async () => {});
  expect(listProject).not.toHaveBeenCalled();
  view.rerender({ enabled: true });
  await act(async () => {});
  await act(async () => {});
  expect(listProject).toHaveBeenCalledWith({ project_id: "p1" });
  expect(
    view.result.current.some((item) => item.title === "Old hub artifact"),
  ).toBe(true);
});
