import { fromJS, Map as ImmutableMap } from "immutable";

import { groupNotificationMentions } from "./notification-groups";
import type { MentionsMap } from "./types";

describe("notification grouping", () => {
  it("groups duplicate account notices and keeps the latest representative", () => {
    const mentions = ImmutableMap({
      "n-1": fromJS({
        kind: "account_notice",
        target: "acct-1",
        project_id: "project-1",
        path: "chat.chat",
        title: "Codex turn finished",
        body_markdown: "Done",
        notice_type: "codex_turn_completion",
        fragment_id: "turn-1",
        thread_id: "thread-1",
        time: new Date("2026-05-08T10:00:00.000Z"),
      }),
      "n-2": fromJS({
        kind: "account_notice",
        target: "acct-1",
        project_id: "project-1",
        path: "chat.chat",
        title: "Codex turn finished",
        body_markdown: "Done",
        notice_type: "codex_turn_completion",
        fragment_id: "turn-2",
        thread_id: "thread-1",
        time: new Date("2026-05-08T10:10:00.000Z"),
      }),
      "n-3": fromJS({
        kind: "account_notice",
        target: "acct-1",
        project_id: "project-1",
        path: "chat.chat",
        title: "Different notice",
        body_markdown: "Done",
        notice_type: "codex_turn_completion",
        thread_id: "thread-1",
        time: new Date("2026-05-08T10:20:00.000Z"),
      }),
    }) as unknown as MentionsMap;

    const groups = groupNotificationMentions(mentions);

    expect(groups).toHaveLength(2);
    expect(groups[0].ids).toEqual(["n-3"]);
    expect(groups[1].ids).toEqual(["n-1", "n-2"]);
    expect(groups[1].mention.get("time")).toEqual(
      new Date("2026-05-08T10:10:00.000Z"),
    );
    expect(groups[1].mention.get("fragment_id")).toBe("turn-2");
    expect(groups[1].firstTime).toEqual(new Date("2026-05-08T10:00:00.000Z"));
    expect(groups[1].latestTime).toEqual(new Date("2026-05-08T10:10:00.000Z"));
  });

  it("does not group ordinary mentions", () => {
    const mentions = ImmutableMap({
      "n-1": fromJS({
        kind: "mention",
        title: "Same",
        time: new Date("2026-05-08T10:00:00.000Z"),
      }),
      "n-2": fromJS({
        kind: "mention",
        title: "Same",
        time: new Date("2026-05-08T10:01:00.000Z"),
      }),
    }) as unknown as MentionsMap;

    expect(
      groupNotificationMentions(mentions).map((group) => group.ids),
    ).toEqual([["n-2"], ["n-1"]]);
  });
});
