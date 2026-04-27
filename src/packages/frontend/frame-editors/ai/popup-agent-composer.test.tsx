/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { PopupAgentComposer } from "./popup-agent-composer";

let lastChatInputProps: any = null;

jest.mock("@cocalc/frontend/chat/input", () => {
  const React = require("react");
  return {
    __esModule: true,
    default: (props: any) => {
      lastChatInputProps = props;
      return React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "popup-agent-composer",
          onClick: () => props.on_send(props.input),
        },
        props.placeholder,
      );
    },
  };
});

describe("PopupAgentComposer", () => {
  beforeEach(() => {
    lastChatInputProps = null;
  });

  it("wraps ChatInput with popup-friendly defaults", () => {
    const onChange = jest.fn();
    const onSubmit = jest.fn();

    render(
      <PopupAgentComposer
        value="hello"
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="What should Agent do?"
        cacheId="popup-agent:test"
        autoFocus
        sessionToken={7}
      />,
    );

    expect(screen.getByTestId("popup-agent-composer")).toBeTruthy();
    expect(lastChatInputProps).toBeTruthy();
    expect(lastChatInputProps.syncdb).toBeUndefined();
    expect(lastChatInputProps.date).toBe(-1);
    expect(lastChatInputProps.autoGrowMaxHeight).toBe(280);
    expect(lastChatInputProps.cacheId).toBe("popup-agent:test");
    expect(lastChatInputProps.placeholder).toBe("What should Agent do?");
    expect(lastChatInputProps.autoFocus).toBe(true);
    expect(lastChatInputProps.sessionToken).toBe(7);

    fireEvent.click(screen.getByTestId("popup-agent-composer"));
    expect(onSubmit).toHaveBeenCalledWith("hello");
  });
});
