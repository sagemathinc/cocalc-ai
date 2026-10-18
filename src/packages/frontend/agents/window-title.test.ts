/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  agentWindowTitle,
  agentsWindowTitle,
  setAgentsWindowTitle,
} from "./window-title";

afterEach(() => setAgentsWindowTitle(undefined));

it("names the tab after the agent's header title, else thread title, else @name", () => {
  expect(
    agentWindowTitle({
      name: "cocalc-lite1",
      thread_title: "old thread title",
      headerTitle: "cocalc: agents",
    }),
  ).toBe("cocalc: agents");
  expect(
    agentWindowTitle({ name: "cocalc-lite1", thread_title: "thread title" }),
  ).toBe("thread title");
  expect(agentWindowTitle({ name: "cocalc-lite1", headerTitle: "  " })).toBe(
    "@cocalc-lite1",
  );
});

it("remembers the open agent's title for returning to the Agents tab", () => {
  expect(agentsWindowTitle()).toBe("Agents");
  setAgentsWindowTitle("cocalc: agents");
  expect(agentsWindowTitle()).toBe("cocalc: agents");
  setAgentsWindowTitle(undefined); // the overview, or no agent open
  expect(agentsWindowTitle()).toBe("Agents");
});
