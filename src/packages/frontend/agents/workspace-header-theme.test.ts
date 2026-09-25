/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  readAgentThreadAppearance,
  resolveAgentHeaderTheme,
  resolveNamedAgentTheme,
  sameAgentHeaderAppearance,
} from "./workspace-header-theme";

it("uses live thread title and theme colors in the Agents header", () => {
  expect(
    resolveAgentHeaderTheme({
      appearance: {
        name: "Release reviewer",
        thread_color: " #123456 ",
        thread_accent_color: " #ffffff ",
        thread_icon: "rocket",
        thread_image: "https://example.com/reviewer.png",
      },
      fallbackTitle: "Fallback agent",
    }),
  ).toMatchObject({
    accentColor: "#ffffff",
    backgroundColor: "#ffffff",
    primaryColor: "#123456",
    textColor: "black",
    title: "Release reviewer",
  });
});

it("uses the registered title until live appearance metadata is available", () => {
  const resolved = resolveAgentHeaderTheme({
    fallbackTitle: "Registered agent",
  });
  expect(resolved.title).toBe("Registered agent");
  expect(resolved.accentColor).toBeUndefined();
  expect(resolved.primaryColor).toBeUndefined();
});

it("uses a visible tint when a thread has a primary color but no accent", () => {
  expect(
    resolveAgentHeaderTheme({
      appearance: { thread_color: "#1677ff" },
      fallbackTitle: "Agent",
    }).backgroundColor,
  ).toContain("color-mix(in srgb, #1677ff 14%");
});

it("detects material thread appearance changes", () => {
  const appearance = { name: "Agent", thread_icon: "robot" };
  expect(sameAgentHeaderAppearance(appearance, appearance)).toBe(true);
  expect(
    sameAgentHeaderAppearance(appearance, {
      ...appearance,
      thread_icon: "rocket",
    }),
  ).toBe(false);
});

it("uses one live presentation for a registered agent", () => {
  const agent = {
    name: "reviewer",
    thread_title: "Reviewer (recv.chat)",
  };
  expect(
    resolveNamedAgentTheme(agent, {
      name: "RPC cross-bay review",
      thread_color: "#cf1322",
      thread_accent_color: "#fff1f0",
      thread_icon: "deployment-unit",
    }),
  ).toMatchObject({
    title: "RPC cross-bay review",
    primaryColor: "#cf1322",
    accentColor: "#fff1f0",
  });
  expect(resolveNamedAgentTheme(agent).title).toBe("Reviewer (recv.chat)");
});

it("reads appearance through the thread lookup key used by chat", () => {
  const rootMessage = { name: "RPC cross-bay receiver" };
  const getThreadMetadata = jest.fn(() => ({
    thread_color: "#2196f3",
    thread_accent_color: "#f44336",
    thread_icon: "deployment-unit",
  }));
  const actions = {
    messageCache: {
      getThreadKeyByThreadId: () => "root-message-date",
    },
    getThreadIndex: () => new Map([["root-message-date", { rootMessage }]]),
    getThreadMetadata,
  };

  expect(readAgentThreadAppearance(actions, "stable-thread-id")).toMatchObject({
    name: "RPC cross-bay receiver",
    thread_color: "#2196f3",
    thread_accent_color: "#f44336",
    thread_icon: "deployment-unit",
  });
  expect(getThreadMetadata).toHaveBeenCalledWith("root-message-date", {
    threadId: "stable-thread-id",
  });
});
