import immutable from "immutable";
import { agentThreadIsRunning } from "./agent-running-indicator";

describe("agentThreadIsRunning", () => {
  it.each(["queue", "sending", "sent", "running", " RUNNING "])(
    "recognizes the active ACP state %s",
    (state) => {
      expect(
        agentThreadIsRunning(
          immutable.Map({ "thread:thread-1": state }),
          "thread-1",
        ),
      ).toBe(true);
    },
  );

  it("does not mark completed or unrelated threads as running", () => {
    const state = immutable.Map({
      "thread:thread-1": "complete",
      "thread:thread-2": "running",
    });
    expect(agentThreadIsRunning(state, "thread-1")).toBe(false);
    expect(agentThreadIsRunning(state, "thread-3")).toBe(false);
  });
});
