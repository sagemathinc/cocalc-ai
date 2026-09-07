/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import Text from "./text";
import { getStyle, getFullStyle } from "./text-static";
import { lightAppearance } from "@cocalc/util/appearance-palette";

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

jest.mock("./text-mostly-static", () => ({
  __esModule: true,
  default: () => <div data-testid="static-text" />,
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
    expect(latestMarkdownProps.style["--cocalc-ui-text"]).toBe(
      lightAppearance.text,
    );
    expect(latestMarkdownProps.style.colorScheme).toBe("light");
  });

  it("does not mount a writable editor for a passive remote cursor", () => {
    render(
      <Text
        canvasScale={1}
        focused={false}
        cursors={{ remote: [{ x: 1, y: 0 }] }}
        element={{
          id: "text-1",
          type: "text",
          str: "remote text",
          x: 0,
          y: 0,
          w: 300,
          h: 100,
          z: 0,
        }}
      />,
    );

    expect(screen.getByTestId("static-text")).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-input")).not.toBeInTheDocument();
    expect(latestMarkdownProps).toBeUndefined();
  });
});

describe("whiteboard paper appearance", () => {
  afterEach(() =>
    document.documentElement.removeAttribute("data-cocalc-theme"),
  );

  it.each(["light", "dark"])("preserves authored colors in %s mode", (mode) => {
    document.documentElement.setAttribute("data-cocalc-theme", mode);
    const element = {
      id: "note",
      type: "text",
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      z: 0,
      data: { color: "#123456", background: "#fff8b0" },
    } as const;
    for (const style of [getStyle(element), getFullStyle(element, false)]) {
      expect(style).toMatchObject({
        colorScheme: "light",
        color: "#123456",
        background: "#fff8b0",
        "--cocalc-ui-text": "#123456",
        "--cocalc-ui-link": lightAppearance.link,
        "--cocalc-ui-codeText": lightAppearance.codeText,
        "--cocalc-ui-surface": lightAppearance.surface,
      });
    }
  });
});
