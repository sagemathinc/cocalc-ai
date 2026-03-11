import { fromJS } from "immutable";
import type {
  Counts,
  LocalTaskStateMap,
  LocalViewStateMap,
  Tasks,
} from "./types";
import { update_visible } from "./update-visible";

const OLDER_TASK_ID = "11111111-1111-4111-8111-111111111111";
const NEWER_TASK_ID = "22222222-2222-4222-8222-222222222222";

function makeTasks() {
  return fromJS({
    [OLDER_TASK_ID]: {
      task_id: OLDER_TASK_ID,
      desc: "older task",
      last_edited: 946684800000,
      position: 0,
    },
    [NEWER_TASK_ID]: {
      task_id: NEWER_TASK_ID,
      desc: "newer task",
      last_edited: 1773200000000,
      position: 1,
    },
  }) as unknown as Tasks;
}

function makeViewState() {
  return fromJS({
    sort: {
      column: "Changed",
      dir: "asc",
    },
  }) as unknown as LocalViewStateMap;
}

function makeCounts() {
  return fromJS({
    done: 0,
    deleted: 0,
  }) as unknown as Counts;
}

describe("update_visible changed sorting while editing", () => {
  it("would move an edited task to the top without a preserved sort anchor", () => {
    const tasks = makeTasks().setIn(
      [OLDER_TASK_ID, "last_edited"],
      1773300000000,
    );
    const localTaskState = fromJS({
      [OLDER_TASK_ID]: {
        editing_desc: true,
      },
    }) as unknown as LocalTaskStateMap;

    const result = update_visible(
      tasks,
      localTaskState,
      makeViewState(),
      makeCounts(),
      OLDER_TASK_ID,
    );

    expect(result.visible.toJS()).toEqual([OLDER_TASK_ID, NEWER_TASK_ID]);
  });

  it("keeps the edited task in place while Changed sorting is active", () => {
    const tasks = makeTasks().setIn(
      [OLDER_TASK_ID, "last_edited"],
      1773300000000,
    );
    const localTaskState = fromJS({
      [OLDER_TASK_ID]: {
        editing_desc: true,
        editing_desc_last_edited: 946684800000,
      },
    }) as unknown as LocalTaskStateMap;

    const result = update_visible(
      tasks,
      localTaskState,
      makeViewState(),
      makeCounts(),
      OLDER_TASK_ID,
    );

    expect(result.visible.toJS()).toEqual([NEWER_TASK_ID, OLDER_TASK_ID]);
  });
});
