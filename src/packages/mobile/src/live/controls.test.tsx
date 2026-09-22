import React from "react";
const { act, create } = require("react-test-renderer");
import { LiveVoiceControls } from "./controls";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it("requires explicit start after showing rate, and exposes mute/end as named controls", async () => {
  const start = jest.fn(),
    end = jest.fn(),
    toggleMute = jest.fn();
  const live: any = {
    capabilities: {
      enabled: true,
      usd_per_minute: 0.05,
      max_seconds: 120,
      funding_source: "account",
    },
    phase: "idle",
    start,
    end,
    toggleMute,
    seconds: 0,
  };
  let screen: any;
  await act(async () => {
    screen = create(<LiveVoiceControls live={live} disabled={false} />);
  });
  const button = (name: string) =>
    screen.root.findAll(
      (node: any) =>
        node.type === "Pressable" &&
        node.props.accessibilityRole === "button" &&
        node.props.accessibilityLabel === name,
    )[0];
  await act(async () => button("Live voice").props.onPress());
  expect(start).not.toHaveBeenCalled();
  expect(JSON.stringify(screen.toJSON())).toContain("0.05");
  await act(async () => button("Start live call").props.onPress());
  expect(start).toHaveBeenCalledTimes(1);
  await act(async () =>
    screen.update(
      <LiveVoiceControls live={{ ...live, phase: "live" }} disabled={false} />,
    ),
  );
  await act(async () => button("Mute microphone").props.onPress());
  await act(async () => button("End live call").props.onPress());
  expect(toggleMute).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledTimes(1);
  await act(async () => screen.unmount());
});

it("does not offer live voice without a server capability", async () => {
  let screen: any;
  await act(async () => {
    screen = create(
      <LiveVoiceControls live={{ phase: "idle" } as any} disabled={false} />,
    );
  });
  expect(screen.toJSON()).toBeNull();
  await act(async () => screen.unmount());
});
