import { sensorWakePresentation } from "../agent-message-presentation";
import { sensorWakeFence } from "@cocalc/frontend/editors/slate/elements/sensor-wake";
import { sensorWakeFromMarkdownFence } from "@cocalc/frontend/editors/slate/elements/sensor-wake";

jest.mock("@cocalc/frontend/editors/slate/markdown-to-slate", () => ({
  markdown_to_slate: (value: string) => [{ text: value }],
}));

test("sensor turns are recognized only in the shape CoCalc writes", () => {
  const wake = [
    '[Sensor wake] "CI" (sensor s) ran at 2026-10-10T18:12:21Z.',
    "This is not a message from a person.",
    'Summary: /home/user/sensor-test.txt now contains "DONE"',
    "[/Sensor wake] Manage this sensor with `cocalc sensor show s`.",
  ].join("\n");
  expect(sensorWakePresentation(wake, "CI")).toEqual({
    kind: "wake",
    title: "CI",
    summary: '/home/user/sensor-test.txt now contains "DONE"',
  });
  expect(
    sensorWakePresentation(
      '[Scheduled prompt] "Briefing" (sensor s): a turn a person scheduled or approved.\n\nSummarize today.',
      "Briefing",
    ),
  ).toEqual({ kind: "prompt", title: "Briefing", summary: "Summarize today." });
  expect(
    sensorWakePresentation(
      "[Reminder] You set this reminder for 2026-10-10T18:18:44Z (sensor s): tell William",
      "Reminder",
    ),
  ).toMatchObject({ kind: "reminder", summary: "tell William" });
  expect(sensorWakePresentation("edited by a person", "CI")).toBeUndefined();
});

test("the fence round-trips the title and summary", () => {
  const fence = sensorWakeFence({
    kind: "wake",
    title: 'a "b" c',
    summary: "x = 1 & y",
    value: "full ``` prompt",
  });
  const [first, ...rest] = fence.split("\n");
  const ticks = first.match(/^`+/)![0];
  const element = sensorWakeFromMarkdownFence({
    info: first.slice(ticks.length),
    value: rest.slice(0, -1).join("\n"),
  });
  expect(element).toMatchObject({
    type: "sensor-wake",
    kind: "wake",
    title: 'a "b" c',
    summary: "x = 1 & y",
  });
  expect(
    sensorWakeFromMarkdownFence({ info: "sensor-wake evil=1", value: "" }),
  ).toBeUndefined();
});
