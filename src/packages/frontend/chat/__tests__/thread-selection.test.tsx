/** @jest-environment jsdom */

import { act, render } from "@testing-library/react";
import { useChatThreadSelection } from "../thread-selection";
import { COMBINED_FEED_KEY, type ThreadMeta } from "../threads";

describe("useChatThreadSelection", () => {
  it("does not fall back to combined feed while a concrete selected thread is temporarily missing", () => {
    const actions = {
      clearAllFilters: jest.fn(),
      setFragment: jest.fn(),
      setSelectedThread: jest.fn(),
    } as any;

    let latest: any = null;

    function Harness({ threads }: { threads: ThreadMeta[] }) {
      latest = useChatThreadSelection({
        actions,
        threads,
        messages: undefined,
        fragmentId: null,
        storedThreadFromDesc: COMBINED_FEED_KEY,
      });
      return null;
    }

    const threads: ThreadMeta[] = [
      {
        key: "100",
        label: "Thread 100",
        displayLabel: "Thread 100",
        newestTime: 100,
        messageCount: 1,
        hasCustomName: false,
        hasCustomAppearance: false,
        readCount: 0,
        unreadCount: 1,
        isAI: false,
        isPinned: false,
        isArchived: false,
      },
    ];

    const { rerender } = render(<Harness threads={threads} />);
    expect(latest.selectedThreadKey).toBe(COMBINED_FEED_KEY);

    act(() => {
      latest.setSelectedThreadKey("200");
    });
    expect(latest.selectedThreadKey).toBe("200");

    // Simulate async lag where thread metadata has not yet included key=200.
    act(() => {
      rerender(<Harness threads={threads} />);
    });
    expect(latest.selectedThreadKey).toBe("200");
  });
});
