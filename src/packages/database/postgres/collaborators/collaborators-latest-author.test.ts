import type { CollaborationResource } from "@cocalc/util/collaborators";
import { validateResource } from "./collaborators-common";

const account = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const resource: CollaborationResource = {
  project_id: "11111111-1111-4111-8111-111111111111",
  kind: "conversation",
  resource_id: "thread",
  thread_id: "thread",
  chat_path: "/home/user/room.chat",
  title: "Discussion",
  participant_ids: [],
  created_at: 1,
  updated_at: 2,
  activity: 1,
};

test("resource validation preserves optional latest-message author without conflating creator", () => {
  expect(validateResource(resource)).not.toHaveProperty(
    "latest_message_author_id",
  );
  expect(
    validateResource({
      ...resource,
      latest_message_author_id: account.toUpperCase(),
    }),
  ).toMatchObject({ latest_message_author_id: account });
  expect(
    validateResource({ ...resource, latest_message_author_id: account }),
  ).not.toHaveProperty("created_by");
});
test.each(["invalid", "", 42])(
  "resource validation rejects malformed latest-message author %s",
  (id) => {
    expect(() =>
      validateResource({ ...resource, latest_message_author_id: id as any }),
    ).toThrow("latest_message_author_id");
  },
);
test.each(["agent", "artifact"] as const)(
  "%s cannot carry conversation latest-message attribution",
  (kind) => {
    expect(() =>
      validateResource({
        ...resource,
        kind,
        latest_message_author_id: account,
      }),
    ).toThrow("conversation");
  },
);
