/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ListedConversation } from "@cocalc/util/people";
import { fdOptions, parseFdOutput, titleFromPath } from "./scan";
import { SEARCH_MAX_CONVERSATIONS, searchConversations } from "./search-dialog";

jest.mock("@cocalc/frontend/app-framework", () => ({ redux: {} }));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({}));
jest.mock("@cocalc/frontend/project/home-directory", () => ({}));
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/components", () => ({ TimeAgo: () => null }));

describe("scan", () => {
  it("finds .chat files, skips agent/cache dirs, and limits to changes since the last scan", () => {
    const first = fdOptions(null);
    expect(first).toEqual(
      expect.arrayContaining([
        "--extension",
        "chat",
        "--hidden",
        "--no-ignore",
      ]),
    );
    expect(first.join(" ")).toContain("--exclude .local");
    expect(first).not.toContain("--changed-within");
    const later = fdOptions(1_000_000, 1_000_000 + 3_600_000);
    const at = later.indexOf("--changed-within");
    // one hour since the last scan, plus a minute of overlap
    expect(later[at + 1]).toBe("3660s");
  });

  it("parses fd output into normalized absolute .chat paths", () => {
    expect(
      parseFdOutput(
        "/home/user",
        "./notes/team.chat\nb.chat\n\n/home/user/x//y.chat\nnot-a-chat.txt\n",
      ),
    ).toEqual([
      "/home/user/b.chat",
      "/home/user/notes/team.chat",
      "/home/user/x/y.chat",
    ]);
    expect(titleFromPath("/home/user/team-planning_2026.chat")).toBe(
      "team planning 2026",
    );
  });
});

describe("message search", () => {
  const conversation = (id: string, last_activity: number) =>
    ({
      conversation_id: id,
      title: id,
      project_id: "p",
      path: `/home/user/${id}.chat`,
      last_activity,
    }) as ListedConversation;

  it("searches the most recent conversations first, bounded, and reports failures", async () => {
    const conversations = Array.from(
      { length: SEARCH_MAX_CONVERSATIONS + 5 },
      (_, i) => conversation(`c${i}`, i),
    );
    const searched: string[] = [];
    let last: { hits: number; searched: number; failed: number } | undefined;
    await searchConversations({
      conversations,
      query: "hello",
      search: async (c) => {
        searched.push(c.conversation_id);
        if (c.conversation_id === "c54")
          return [{ row_id: 1, segment_id: "head", date_ms: 9 }];
        if (c.conversation_id === "c53") throw Error("unavailable");
        return [];
      },
      onProgress: (hits, searched, failed) => {
        last = { hits: hits.length, searched, failed };
      },
      canceled: () => false,
    });
    expect(searched).toHaveLength(SEARCH_MAX_CONVERSATIONS);
    expect(searched[0]).toBe("c54");
    expect(last).toEqual({
      hits: 1,
      searched: SEARCH_MAX_CONVERSATIONS,
      failed: 1,
    });
  });

  it("stops when canceled", async () => {
    let calls = 0;
    await searchConversations({
      conversations: [conversation("a", 2), conversation("b", 1)],
      query: "x",
      search: async () => {
        calls += 1;
        return [];
      },
      onProgress: () => {},
      canceled: () => calls > 0,
    });
    expect(calls).toBe(1);
  });
});

describe("ripgrep hits", () => {
  it("parses chat records from ripgrep --json and quotes around the match", () => {
    const { hitsFromRipgrepJson, globLiteral } = require("./search-dialog");
    const record = JSON.stringify({
      event: "chat",
      date: "2026-09-30T05:53:12.000Z",
      thread_id: "t1",
      history: [{ content: "well hello from the small PR, and more" }],
    });
    const stdout = [
      JSON.stringify({ type: "begin", data: {} }),
      JSON.stringify({
        type: "match",
        data: { line_number: 4, lines: { text: record + "\n" } },
      }),
      JSON.stringify({
        type: "match",
        data: { line_number: 5, lines: { text: '{"event":"draft"}' } },
      }),
    ].join("\n");
    expect(hitsFromRipgrepJson(stdout, "HELLO")).toEqual([
      {
        row_id: 4,
        segment_id: "head",
        thread_id: "t1",
        date_ms: Date.parse("2026-09-30T05:53:12.000Z"),
        snippet: "well hello from the small PR, and more",
      },
    ]);
    expect(globLiteral("a*b[1].chat")).toBe("a\\*b\\[1\\].chat");
  });
});
