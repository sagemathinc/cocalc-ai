import {
  createTurnActivityStore,
  EMPTY_TURN_ACTIVITY,
  type TurnActivity,
} from "../turn-activity";
import type { TurnTimelineRow } from "../turn-timeline";

function activity(rows: TurnTimelineRow[]): TurnActivity {
  return {
    ...EMPTY_TURN_ACTIVITY,
    rows,
    rowIndex: new Map(rows.map((row, i) => [row.id, i])),
  };
}

test("only added or removed rows change the list; row content updates the turn", () => {
  const store = createTurnActivityStore();
  const onRows = jest.fn();
  const onTurn = jest.fn();
  store.subscribeRows(onRows);
  store.subscribe("assistant-1", onTurn);

  store.set(
    "assistant-1",
    activity([{ kind: "agent", id: "agent:0:0", text: "Read" }]),
  );
  expect(onRows).toHaveBeenCalledTimes(1);
  const version = store.rowsVersion();

  // The streaming tail grows: same rows, new content.
  store.set(
    "assistant-1",
    activity([{ kind: "agent", id: "agent:0:0", text: "Reading the code" }]),
  );
  expect(onTurn).toHaveBeenCalledTimes(2);
  expect(onRows).toHaveBeenCalledTimes(1);
  expect(store.rowsVersion()).toBe(version);

  store.set(
    "assistant-1",
    activity([
      { kind: "agent", id: "agent:0:0", text: "Reading the code" },
      { kind: "guidance", id: "guidance:5:0:0", text: "also docs" },
    ]),
  );
  expect(onRows).toHaveBeenCalledTimes(2);

  store.set("assistant-1", undefined);
  expect(onRows).toHaveBeenCalledTimes(3);
  expect(store.get("assistant-1")).toBeUndefined();
});
