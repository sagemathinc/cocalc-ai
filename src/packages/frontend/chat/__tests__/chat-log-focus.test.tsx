import { render } from "@testing-library/react";
import { MessageList } from "../chat-log";

describe("MessageList focusLogRef", () => {
  it("focuses the message list container when requested", () => {
    const focusLogRef: { current: (() => void) | null } = { current: null };

    render(
      <MessageList
        messages={new Map() as any}
        account_id="account-1"
        user_map={null}
        mode="standalone"
        sortedDates={[]}
        focusLogRef={focusLogRef as any}
      />,
    );

    expect(typeof focusLogRef.current).toBe("function");
    focusLogRef.current?.();
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });
});
