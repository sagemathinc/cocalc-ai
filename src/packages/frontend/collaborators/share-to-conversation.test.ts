import type { CollaborationResource } from "@cocalc/util/collaborators";
import {
  collaborationReferenceFromResource,
  parseCollaborationReference,
} from "@cocalc/util/collaboration-references";
import { shareReferenceToConversation } from "./share-to-conversation";

let mockAccount = "alice";
const mockWrite = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getStore: () => ({ get: () => mockAccount }) },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: { conat_client: {} },
}));
jest.mock("@cocalc/frontend/chat/use-chat-composer-draft", () => ({
  writeChatComposerDraft: (...args) => mockWrite(...args),
}));

const source: CollaborationResource = {
  project_id: "11111111-1111-4111-8111-111111111111",
  resource_id: "artifact",
  kind: "artifact",
  title: "Original result",
  chat_path: "/source.chat",
  thread_id: "source-thread",
  participant_ids: [],
  activity: 1,
  created_at: 1,
  updated_at: 1,
};
const destination: CollaborationResource = {
  ...source,
  project_id: "22222222-2222-4222-8222-222222222222",
  resource_id: "human",
  kind: "conversation",
  thread_id: "human-thread",
  chat_path: "/human.chat",
};
const reference = collaborationReferenceFromResource(source);
let getResource: jest.Mock;
function share(isCurrent = () => true) {
  return shareReferenceToConversation({
    accountId: "alice",
    reference,
    destination,
    isCurrent,
    api: { getResource, listResources: jest.fn() },
  });
}
beforeEach(() => {
  mockAccount = "alice";
  mockWrite.mockReset().mockResolvedValue("draft");
  getResource = jest.fn(async ({ kind }) =>
    kind === "artifact" ? source : destination,
  );
});

test("binds the original typed target and appends to the authorized destination, without opening any runtime", async () => {
  const moved = { ...destination, chat_path: "/moved.chat" };
  getResource.mockImplementation(async ({ kind }) =>
    kind === "artifact" ? source : moved,
  );
  expect(await share()).toEqual(moved);
  expect(getResource).toHaveBeenCalledWith({
    ...reference.target,
    account_id: "alice",
  });
  expect(getResource).toHaveBeenCalledWith({
    project_id: destination.project_id,
    resource_id: "human",
    kind: "conversation",
    account_id: "alice",
  });
  expect(mockWrite).toHaveBeenCalledTimes(1);
  const opts = mockWrite.mock.calls[0][0];
  expect(opts).toMatchObject({
    account_id: "alice",
    project_id: destination.project_id,
    path: "/moved.chat",
    append: true,
  });
  expect(parseCollaborationReference(opts.text)).toEqual(reference);
  expect(opts.isCurrent()).toBe(true);
  mockAccount = "bob";
  expect(opts.isCurrent()).toBe(false);
});

test.each([
  null,
  { ...destination, kind: "agent" },
  { ...destination, archived: true },
  { ...destination, resource_id: "other" },
  { ...destination, thread_id: "" },
])(
  "rejects a revoked, changed, archived, or non-human destination: %p",
  async (result) => {
    getResource.mockImplementation(async ({ kind }) =>
      kind === "artifact" ? source : result,
    );
    await expect(share()).rejects.toThrow("no longer available");
    expect(mockWrite).not.toHaveBeenCalled();
  },
);
test("rejects a revoked source even if destination access remains", async () => {
  getResource.mockImplementation(async ({ kind }) =>
    kind === "artifact" ? null : destination,
  );
  await expect(share()).rejects.toThrow("no longer available");
  expect(mockWrite).not.toHaveBeenCalled();
});
test.each(["account", "selection"])(
  "rejects a late point lookup after %s changed",
  async (change) => {
    let finish!: (value: CollaborationResource) => void;
    let selected = true;
    getResource.mockImplementation(async ({ kind }) =>
      kind === "artifact"
        ? source
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const pending = share(() => selected);
    if (change === "account") mockAccount = "bob";
    else selected = false;
    finish(destination);
    await expect(pending).rejects.toThrow("changed");
    expect(mockWrite).not.toHaveBeenCalled();
  },
);
