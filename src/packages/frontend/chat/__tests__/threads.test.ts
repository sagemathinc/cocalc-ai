import { groupThreadsByRecency, type ThreadMeta } from "../threads";

function makeThread(
  key: string,
  newestTime: number,
  patch: Partial<ThreadMeta> = {},
): ThreadMeta {
  return {
    key,
    label: key,
    displayLabel: key,
    newestTime,
    messageCount: 1,
    hasCustomName: false,
    hasCustomAppearance: false,
    readCount: 1,
    unreadCount: 0,
    isAI: true,
    isAutomation: false,
    isPinned: false,
    isArchived: false,
    ...patch,
  };
}

describe("groupThreadsByRecency", () => {
  it("places automation threads in their own section below Today", () => {
    const now = Date.UTC(2026, 2, 12, 12, 0, 0);
    const sections = groupThreadsByRecency(
      [
        makeThread("today-thread", now - 60_000),
        makeThread("automation-thread", now - 2 * 60_000, {
          isAutomation: true,
          isPinned: true,
        }),
        makeThread("yesterday-thread", now - 26 * 60 * 60_000),
      ],
      { now },
    );

    expect(sections.map((section) => section.key)).toEqual([
      "today",
      "automations",
      "yesterday",
    ]);
    expect(sections[1].threads.map((thread) => thread.key)).toEqual([
      "automation-thread",
    ]);
  });
});
