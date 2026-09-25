import React from "react";
const { act, create } = require("react-test-renderer");
import { LiveVoiceControls } from "./controls";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
jest.mock("../cocalc/session-registry", () => ({
  getActiveSiteSession: jest.fn(),
}));

it("requires explicit start without exposing prices and names mute/end controls", async () => {
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
  expect(JSON.stringify(screen.toJSON())).not.toContain("0.05");
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

it("shows included AI windows and allows an explicit own-key choice", async () => {
  const chooseFunding = jest.fn();
  const live: any = {
    capabilities: {
      enabled: true,
      max_seconds: 120,
      funding_source: "site",
      own_key_available: true,
      allowance: [
        { window: "5h", remaining_percent: 67 },
        { window: "7d", remaining_percent: 42 },
      ],
    },
    fundingPreference: "site",
    chooseFunding,
    phase: "idle",
  };
  let screen: any;
  await act(async () => {
    screen = create(<LiveVoiceControls live={live} disabled={false} />);
  });
  const labels = screen.root
    .findAllByType("Text")
    .map((node: any) => node.children.join(""));
  expect(labels).toContain("5-hour");
  expect(labels).toContain("7-day");
  expect(labels).toContain("67%");
  expect(labels).toContain("42%");
  const meter = screen.root.findByProps({
    accessibilityRole: "progressbar",
    accessibilityLabel: "5-hour limit",
  });
  expect(meter.props.accessibilityValue.now).toBe(67);
  const choice = screen.root.findAllByProps({
    accessibilityRole: "button",
    accessibilityLabel: "Use my OpenAI key",
  })[0];
  await act(async () => choice.props.onPress());
  expect(chooseFunding).toHaveBeenCalledWith("own");
  await act(async () => screen.unmount());
});

it("shows a membership or own-key dialog for free users", async () => {
  const chooseFunding = jest.fn();
  const live: any = {
    capabilities: {
      enabled: false,
      max_seconds: 120,
      own_key_available: true,
      reason: "Included live voice requires a paid membership.",
    },
    fundingPreference: "site",
    chooseFunding,
    phase: "idle",
  };
  let screen: any;
  await act(async () => {
    screen = create(<LiveVoiceControls live={live} disabled={false} />);
  });
  const button = (name: string) =>
    screen.root.findByProps({
      accessibilityRole: "button",
      accessibilityLabel: name,
    });
  await act(async () => button("Live voice").props.onPress());
  expect(
    screen.root
      .findAllByType("Modal")
      .some((modal: any) => modal.props.visible),
  ).toBe(true);
  await act(async () => button("Use my OpenAI key").props.onPress());
  expect(chooseFunding).toHaveBeenCalledWith("own");
  expect(
    screen.root
      .findAllByType("Modal")
      .every((modal: any) => !modal.props.visible),
  ).toBe(true);
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

it("keeps idle voice options hidden until opened and offers dictation and close", async () => {
  const onDictate = jest.fn();
  const onClose = jest.fn();
  const live: any = {
    capabilities: { enabled: true, max_seconds: 120, funding_source: "site" },
    phase: "idle",
  };
  let screen: any;
  await act(async () => {
    screen = create(
      <LiveVoiceControls
        live={live}
        disabled={false}
        open={false}
        onDictate={onDictate}
        onClose={onClose}
      />,
    );
  });
  expect(screen.toJSON()).toBeNull();
  await act(async () => {
    screen.update(
      <LiveVoiceControls
        live={live}
        disabled={false}
        open
        onDictate={onDictate}
        onClose={onClose}
      />,
    );
  });
  await act(async () =>
    screen.root
      .findByProps({ accessibilityLabel: "How this works" })
      .props.onPress(),
  );
  expect(
    screen.root
      .findAllByType("Modal")
      .some((modal: any) => modal.props.visible),
  ).toBe(true);
  expect(JSON.stringify(screen.toJSON())).toContain(
    "ordinary messages from you",
  );
  await act(async () =>
    screen.root
      .findByProps({ accessibilityLabel: "Close voice explanation" })
      .props.onPress(),
  );
  await act(async () =>
    screen.root
      .findByProps({ accessibilityLabel: "Dictate message" })
      .props.onPress(),
  );
  expect(onDictate).toHaveBeenCalledTimes(1);
  await act(async () =>
    screen.root
      .findByProps({ accessibilityLabel: "Close voice options" })
      .props.onPress(),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => screen.unmount());
});
