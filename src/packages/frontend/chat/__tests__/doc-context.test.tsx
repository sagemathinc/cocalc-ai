import { EventEmitter } from "events";
import { render, screen } from "@testing-library/react";
import { ChatDocProvider, useChatDoc } from "../doc-context";

class FakeCache extends EventEmitter {
  constructor(
    private readonly messages: Map<string, any>,
    private readonly threadIndex: Map<string, any>,
  ) {
    super();
  }

  getMessages() {
    return this.messages;
  }

  getThreadIndex() {
    return this.threadIndex;
  }
}

function Consumer() {
  const { messages, threadIndex } = useChatDoc();
  return (
    <div>
      <span data-testid="messages">{messages?.size ?? 0}</span>
      <span data-testid="threads">{threadIndex?.size ?? 0}</span>
    </div>
  );
}

describe("ChatDocProvider", () => {
  it("updates consumers immediately when the cache instance changes without a version event", () => {
    const firstCache = new FakeCache(
      new Map([["a", { text: "first" }]]),
      new Map([["thread-1", { key: "thread-1" }]]),
    );
    const secondCache = new FakeCache(
      new Map([
        ["b", { text: "second" }],
        ["c", { text: "third" }],
      ]),
      new Map([
        ["thread-2", { key: "thread-2" }],
        ["thread-3", { key: "thread-3" }],
      ]),
    );

    const { rerender } = render(
      <ChatDocProvider cache={firstCache as any}>
        <Consumer />
      </ChatDocProvider>,
    );

    expect(screen.getByTestId("messages").textContent).toBe("1");
    expect(screen.getByTestId("threads").textContent).toBe("1");

    rerender(
      <ChatDocProvider cache={secondCache as any}>
        <Consumer />
      </ChatDocProvider>,
    );

    expect(screen.getByTestId("messages").textContent).toBe("2");
    expect(screen.getByTestId("threads").textContent).toBe("2");
  });
});
