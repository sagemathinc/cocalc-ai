import { Map } from "immutable";
import type { ChatActions } from "./actions";
import { waitForCommentAcceptance } from "./comment-send-status";

describe("voice uses durable ACP acceptance", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function fixture() {
    let state = "sending";
    const actions = {
      store: { get: () => Map({ "message:request-1": state }) },
      getMessageById: () => ({ message_id: "request-1" }),
    } as unknown as ChatActions;
    const abort = new AbortController();
    return {
      actions,
      abort,
      setState: (value: string) => {
        state = value;
      },
    };
  }

  it("does not acknowledge a local write before ACP accepts", async () => {
    const { actions, abort, setState } = fixture();
    const accepted = jest.fn();
    const pending = waitForCommentAcceptance(
      actions,
      "request-1",
      abort.signal,
    ).then(accepted);
    await jest.advanceTimersByTimeAsync(100);
    expect(accepted).not.toHaveBeenCalled();
    setState("queue");
    await jest.advanceTimersByTimeAsync(100);
    await pending;
    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it("rejects an unaccepted request rather than claiming acceptance", async () => {
    const { actions, abort, setState } = fixture();
    const pending = waitForCommentAcceptance(
      actions,
      "request-1",
      abort.signal,
    );
    const rejected = expect(pending).rejects.toThrow(/not confirmed/);
    setState("not-sent");
    await jest.advanceTimersByTimeAsync(100);
    await rejected;
  });

  it("stops waiting when the voice call is cancelled", async () => {
    const { actions, abort } = fixture();
    const pending = waitForCommentAcceptance(
      actions,
      "request-1",
      abort.signal,
    );
    const rejected = expect(pending).rejects.toThrow(/closed/);
    abort.abort();
    await jest.advanceTimersByTimeAsync(100);
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
  });
});
