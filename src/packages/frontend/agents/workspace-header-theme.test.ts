/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  resolveAgentHeaderTheme,
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
