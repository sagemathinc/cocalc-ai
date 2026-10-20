/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { act } from "@testing-library/react";
import {
  AgentStatusMark,
  agentRowLabel,
  useAgentStatusNow,
} from "./agent-status-mark";

const NOW = Date.parse("2026-10-20T06:00:00Z");
const status = (extra = {}) => ({
  version: 1 as const,
  running: 0,
  queued: 0,
  at: NOW - 60_000,
  ...extra,
});

describe("an agent's status mark", () => {
  it("says until when an agent is out of its usage limit", () => {
    render(
      <AgentStatusMark
        now={NOW}
        status={status({
          unavailable: { reason: "limit", until: NOW + 3_600_000 },
        })}
      />,
    );
    expect(
      screen.getByRole("img", {
        name: /^Unavailable until .* \(usage limit\)$/,
      }),
    ).toBeTruthy();
  });

  it("says when its sign-in needs renewing", () => {
    render(
      <AgentStatusMark
        now={NOW}
        status={status({ unavailable: { reason: "sign-in" } })}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Unavailable (sign-in needs renewing)" }),
    ).toBeTruthy();
  });

  it("shows nothing when it is available, the limit reset, or it is stale", () => {
    for (const s of [
      undefined,
      status(),
      status({ running: 1 }),
      status({ unavailable: { reason: "limit", until: NOW - 1 } }),
      status({
        unavailable: { reason: "sign-in" },
        at: NOW - 2 * 24 * 60 * 60_000,
      }),
    ]) {
      const { container, unmount } = render(
        <AgentStatusMark now={NOW} status={s} />,
      );
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });

  it("goes away on its own when the limit resets, with nothing else rendering", () => {
    jest.useFakeTimers({ now: NOW });
    try {
      render(
        <AgentStatusMark
          status={status({
            unavailable: { reason: "limit", until: NOW + 60_000 },
          })}
        />,
      );
      expect(screen.queryByRole("img")).toBeTruthy();
      act(() => {
        jest.setSystemTime(NOW + 62_000);
        jest.advanceTimersByTime(62_000);
      });
      expect(screen.queryByRole("img")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("is part of the row's accessible name", () => {
    const parts = { title: "Matlab", name: "matlab", project: "Research" };
    expect(agentRowLabel(parts, undefined, NOW)).toBe(
      "Matlab, @matlab, Research",
    );
    expect(
      agentRowLabel(parts, status({ unavailable: { reason: "sign-in" } }), NOW),
    ).toBe("Matlab, @matlab, Research, Unavailable (sign-in needs renewing)");
  });
});

describe("a list of agent rows", () => {
  function Rows({ statuses }: { statuses: any[] }) {
    const now = useAgentStatusNow(statuses);
    return (
      <div>
        {statuses.map((s, i) => (
          <button
            key={i}
            aria-label={agentRowLabel(
              { title: `Agent ${i}`, name: `a${i}`, project: "P" },
              s,
              now,
            )}
          >
            <AgentStatusMark status={s} now={now} />
          </button>
        ))}
      </div>
    );
  }

  it("updates each row's label together with its mark when a limit resets", () => {
    jest.useFakeTimers({ now: NOW });
    try {
      render(
        <Rows
          statuses={[
            status({ unavailable: { reason: "limit", until: NOW + 60_000 } }),
            status({ unavailable: { reason: "limit", until: NOW + 120_000 } }),
          ]}
        />,
      );
      const labels = () =>
        screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
      expect(labels().filter((l) => /Unavailable/.test(l!))).toHaveLength(2);
      act(() => {
        jest.advanceTimersByTime(62_000);
      });
      expect(labels()[0]).toBe("Agent 0, @a0, P");
      expect(labels()[1]).toMatch(/Unavailable/);
      expect(screen.getAllByRole("img")).toHaveLength(1);
      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(labels()[1]).toBe("Agent 1, @a1, P");
      expect(screen.queryAllByRole("img")).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
