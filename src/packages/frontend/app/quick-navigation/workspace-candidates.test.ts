/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/agents/artifact-catalog-store", () => ({
  artifactIdentity: (hit) => hit.catalogEntryId,
}));
jest.mock("@cocalc/frontend/chat/use-artifact-pins", () => ({}));
jest.mock("@cocalc/frontend/people/use-conversations", () => ({}));
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/users/display-name", () => ({}));
jest.mock("@cocalc/frontend/app-framework", () => ({}));

import { workspaceCandidates } from "./workspace-candidates";

const hit = (id: string, title: string) => ({
  hit: {
    catalogEntryId: id,
    agent: { name: "helper", endpoint: { project_id: "p" } },
    hit: { artifact_title: title, artifact_kind: "file" },
  } as any,
});

test("workspace pages, actions, artifacts, conversations and people", () => {
  const items = workspaceCandidates({
    artifacts: [hit("e1", "Report"), hit("e2", "Plot")],
    artifactPins: ["e2"],
    conversations: [
      {
        conversation_id: "c1",
        project_id: "p",
        title: "Weekly",
        pinned: true,
        last_activity: 5,
      } as any,
    ],
    people: [{ account_id: "a", name: "Ana" }],
    projectTitle: () => "Thesis",
    sidebarHidden: true,
  });
  const byId = new Map(items.map((item) => [item.id, item]));
  expect(byId.get("app:library")?.destination).toEqual({
    kind: "app-page",
    page: "library",
  });
  expect(byId.get("action:toggle-sidebar")?.title).toBe("Show sidebar");
  // Pinned artifacts rank above other artifacts.
  expect(byId.get("artifact:p/e2")!.priority).toBeLessThan(
    byId.get("artifact:p/e1")!.priority,
  );
  expect(byId.get("artifact:p/e1")).toMatchObject({
    title: "Report",
    detail: "Library › @helper · file",
    keywords: "Thesis",
    destination: { kind: "artifact", projectId: "p", entryId: "e1" },
  });
  expect(byId.get("conversation:p/c1")).toMatchObject({
    title: "Weekly",
    detail: "People › Thesis · Pinned",
  });
  expect(byId.get("person:a")?.destination).toEqual({
    kind: "person",
    accountId: "a",
  });
});
