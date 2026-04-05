import {
  buildNotificationInboxMap,
  getUnreadNotificationCount,
} from "./actions";

describe("notification inbox mention adapter", () => {
  it("maps projected inbox rows into frontend notification rows", () => {
    const map = buildNotificationInboxMap({
      account_id: "11111111-1111-4111-8111-111111111111",
      rows: [
        {
          notification_id: "22222222-2222-4222-8222-222222222222",
          kind: "mention",
          project_id: "33333333-3333-4333-8333-333333333333",
          summary: {
            path: "chat/chat.sage-chat",
            description: "hello",
            actor_account_id: "44444444-4444-4444-8444-444444444444",
            fragment_id: "chat=true,id=abc",
            priority: 2,
          },
          read_state: {
            read: false,
            saved: true,
          },
          created_at: new Date("2026-04-04T16:00:00Z"),
          updated_at: new Date("2026-04-04T16:00:00Z"),
        },
        {
          notification_id: "55555555-5555-4555-8555-555555555555",
          kind: "account_notice",
          project_id: null,
          summary: {
            title: "Suspicious login",
            body_markdown: "Please review this event.",
            severity: "warning",
            origin_label: "Security",
          },
          read_state: {
            read: true,
          },
          created_at: new Date("2026-04-04T17:00:00Z"),
          updated_at: new Date("2026-04-04T17:00:00Z"),
        },
        {
          notification_id: "66666666-6666-4666-8666-666666666666",
          kind: "mention",
          project_id: null,
          summary: {},
          read_state: {
            archived: true,
          },
          created_at: new Date("2026-04-04T18:00:00Z"),
          updated_at: new Date("2026-04-04T18:00:00Z"),
        },
      ],
    });

    expect(map.size).toBe(2);
    const mention = map.get("22222222-2222-4222-8222-222222222222");
    expect(mention?.get("kind")).toBe("mention");
    expect(mention?.get("path")).toBe("chat/chat.sage-chat");
    expect(mention?.get("source")).toBe("44444444-4444-4444-8444-444444444444");
    expect(
      mention?.getIn([
        "users",
        "11111111-1111-4111-8111-111111111111",
        "saved",
      ]),
    ).toBe(true);

    const notice = map.get("55555555-5555-4555-8555-555555555555");
    expect(notice?.get("kind")).toBe("account_notice");
    expect(notice?.get("title")).toBe("Suspicious login");
    expect(notice?.get("origin_label")).toBe("Security");
  });

  it("uses total unread counts from the projected inbox", () => {
    expect(
      getUnreadNotificationCount({
        total: 4,
        unread: 3,
        saved: 1,
        archived: 0,
        by_kind: {},
      }),
    ).toBe(3);
  });
});
