import { EventEmitter } from "events";
import { useLayoutEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import { ChatDocProvider, useChatDoc } from "../doc-context";

class FakeCache extends EventEmitter {
  private version = 0;

  constructor(
    private messages: Map<string, any>,
    private threadIndex: Map<string, any>,
  ) {
    super();
  }

  getVersion() {
    return this.version;
  }

  getMessages() {
    return this.messages;
  }

  getThreadIndex() {
    return this.threadIndex;
  }

  publish(
    messages: Map<string, any>,
    threadIndex: Map<string, any> = this.threadIndex,
  ) {
    this.messages = messages;
    this.threadIndex = threadIndex;
    this.version += 1;
    this.emit("version", this.version);
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

  it("does not miss a cache update before the subscription attaches", () => {
    const cache = new FakeCache(new Map(), new Map());

    function PublishOnMount() {
      useLayoutEffect(() => {
        cache.publish(
          new Map([["guidance-1", { text: "hello", state: "sending" }]]),
        );
      }, []);
      return null;
    }

    render(
      <ChatDocProvider cache={cache as any}>
        <Consumer />
        <PublishOnMount />
      </ChatDocProvider>,
    );

    expect(screen.getByTestId("messages").textContent).toBe("1");
  });

  it("updates consumers from a cache event without a parent rerender", () => {
    const cache = new FakeCache(new Map(), new Map());
    render(
      <ChatDocProvider cache={cache as any}>
        <Consumer />
      </ChatDocProvider>,
    );

    act(() => {
      cache.publish(
        new Map([["guidance-1", { text: "hello", state: "sending" }]]),
      );
    });

    expect(screen.getByTestId("messages").textContent).toBe("1");
  });
});
