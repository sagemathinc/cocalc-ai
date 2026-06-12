/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import Text from "./text";

let latestMarkdownProps: any;
const setElement = jest.fn();
const setCursors = jest.fn();
const save = jest.fn();

jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: (props: any) => {
    latestMarkdownProps = props;
    return <div data-testid="markdown-input" />;
  },
}));

jest.mock("../hooks", () => ({
  useFrameContext: () => ({
    actions: {
      in_undo_mode: () => false,
      save,
      setCursors,
      setElement,
      undo: jest.fn(),
      redo: jest.fn(),
    },
  }),
}));

jest.mock("./edit-focus", () => ({
  __esModule: true,
  default: () => [true, jest.fn()],
}));

jest.mock("./mouse-click-drag", () => ({
  __esModule: true,
  default: () => ({}),
}));

jest.mock("use-resize-observer", () => ({
  __esModule: true,
  default: () => ({}),
}));

describe("whiteboard text editor", () => {
  beforeEach(() => {
    latestMarkdownProps = undefined;
    setElement.mockClear();
    setCursors.mockClear();
    save.mockClear();
  });

  it("uses unbounded markdown auto-grow so whiteboard notes measure full height", () => {
    render(
      <Text
        canvasScale={1}
        focused
        element={{
          id: "text-1",
          type: "text",
          str: "hello",
          x: 0,
          y: 0,
          w: 300,
          h: 100,
          z: 0,
        }}
      />,
    );

    expect(screen.getByTestId("markdown-input")).toBeInTheDocument();
    expect(latestMarkdownProps.autoGrow).toBe(true);
    expect(latestMarkdownProps.unboundedAutoGrow).toBe(true);
  });
});
