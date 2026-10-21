import { Map as ImmutableMap } from "immutable";
import {
  sidebarRecentAgents,
  sidebarRecentAgentsCount,
  waitingKey,
  waitingThreads,
  waitingThreadsFromAttention,
} from "./sidebar-recent";

const notice = (fields: Record<string, unknown>) =>
  ImmutableMap<string, unknown>({ notice_type: "codex_attention", ...fields });

describe("the sidebar's recent agents", () => {
  it("shows 3, or the count the person chose", () => {
    expect(sidebarRecentAgentsCount(undefined)).toBe(3);
    expect(sidebarRecentAgentsCount(7)).toBe(7);
    // Only the offered choices.
    expect(sidebarRecentAgentsCount(4)).toBe(3);
    expect(sidebarRecentAgentsCount("10")).toBe(3);
  });

  it("knows which conversations wait for an answer, from open notices only", () => {
    const mentions = ImmutableMap({
      a: notice({ project_id: "p1", thread_id: "t1" }),
      // No state yet counts as pending.
      b: notice({
        project_id: "p1",
        thread_id: "t2",
        attention_state: "pending",
      }),
      c: notice({
        project_id: "p2",
        thread_id: "t3",
        attention_state: "answered",
      }),
      d: ImmutableMap({
        notice_type: "mention",
        project_id: "p3",
        thread_id: "t4",
      }),
      e: notice({ project_id: "p4" }),
    });
    expect([...waitingThreads(mentions)].sort()).toEqual([
      waitingKey("p1", "t1"),
      waitingKey("p1", "t2"),
    ]);
    expect(waitingThreads(undefined).size).toBe(0);
  });

  it("in CoCalc Lite, knows the same from the project's attention records", () => {
    const record = (fields: Record<string, unknown>) => ({
      project_id: "p1",
      thread_id: "t1",
      account_id: "me",
      state: "pending",
      ...fields,
    });
    expect(
      [
        ...waitingThreadsFromAttention(
          [
            record({}),
            // Answered, but not yet delivered: no longer waiting for me.
            record({ thread_id: "t2", response_submitted_at: 1 }),
            record({ thread_id: "t3", state: "stale" }),
            record({ thread_id: "t4", account_id: "someone-else" }),
            record({ thread_id: "t5", expires_at: 500 }),
            record({ thread_id: "t6", expires_at: 2_000 }),
            record({ thread_id: null }),
          ],
          "me",
          1_000,
        ),
      ].sort(),
    ).toEqual([waitingKey("p1", "t1"), waitingKey("p1", "t6")]);
    expect(waitingThreadsFromAttention(undefined).size).toBe(0);
  });

  it("lists the most recent, then every agent waiting for an answer, then the open one", () => {
    const agents = ["a", "b", "c", "d", "e", "f"];
    expect(
      sidebarRecentAgents(agents, {
        count: 2,
        isWaiting: (agent) => agent === "e",
        selected: "f",
      }),
    ).toEqual(["a", "b", "e", "f"]);
    // Nothing twice.
    expect(
      sidebarRecentAgents(agents, {
        count: 3,
        isWaiting: (agent) => agent === "a" || agent === "d",
        selected: "d",
      }),
    ).toEqual(["a", "b", "c", "d"]);
  });
});
