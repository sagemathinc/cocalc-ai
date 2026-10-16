/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  agentMessageFence,
  agentMessageWaitingDelivery,
} from "./agent-message-presentation";

describe("agentMessageWaitingDelivery", () => {
  test("only a waiting message gets a notice", () => {
    expect(
      agentMessageWaitingDelivery(
        { configured_delivery: "queued", effective_delivery: "queued" },
        false,
      ),
    ).toBeUndefined();
    expect(agentMessageWaitingDelivery(undefined, true)).toBeUndefined();
  });

  test("a queued network queues by design", () => {
    expect(
      agentMessageWaitingDelivery(
        { configured_delivery: "queued", effective_delivery: "queued" },
        true,
      ),
    ).toBe("queued");
  });

  test("a waiting message in a live network fell back to the queue", () => {
    // The recipient row is stamped "live-guidance" for every live message,
    // even when it ends up waiting (review on #1105).
    expect(
      agentMessageWaitingDelivery(
        { configured_delivery: "live", effective_delivery: "live-guidance" },
        true,
      ),
    ).toBe("queued-fallback");
  });

  test("rows without a configured mode fall back to the stamped delivery", () => {
    expect(
      agentMessageWaitingDelivery(
        { effective_delivery: "live-guidance" },
        true,
      ),
    ).toBe("queued-fallback");
    expect(
      agentMessageWaitingDelivery({ effective_delivery: "queued" }, true),
    ).toBe("queued");
  });
});

test("the waiting hint travels in the card fence", () => {
  expect(
    agentMessageFence("Hello", {
      direction: "incoming",
      source_label: "@ops1",
      delivery: "queued-fallback",
    }).split("\n")[0],
  ).toBe(
    "```agent-message direction=incoming from=%40ops1 delivery=queued-fallback",
  );
});
