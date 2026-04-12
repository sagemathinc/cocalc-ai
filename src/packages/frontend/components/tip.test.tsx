import { render, screen } from "@testing-library/react";

import { Tip, Tooltip } from "./tip";

let isTouch = false;
let hideTooltips = false;

jest.mock("antd", () => ({
  Popover: ({ children }: any) => (
    <div data-testid="antd-popover">{children}</div>
  ),
  Tooltip: ({ children }: any) => (
    <div data-testid="antd-tooltip">{children}</div>
  ),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => ({
    get: (key: string) =>
      key === "hide_button_tooltips" ? hideTooltips : undefined,
  }),
}));

jest.mock("../feature", () => ({
  get IS_TOUCH() {
    return isTouch;
  },
}));

describe("tooltip wrappers", () => {
  beforeEach(() => {
    isTouch = false;
    hideTooltips = false;
  });

  it("renders the shared Tooltip when tooltips are enabled", () => {
    render(
      <Tooltip title="Helpful">
        <button type="button">Open</button>
      </Tooltip>,
    );

    expect(screen.getByTestId("antd-tooltip")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("suppresses Tooltip on touch devices by default", () => {
    isTouch = true;

    render(
      <Tooltip title="Helpful">
        <button type="button">Open</button>
      </Tooltip>,
    );

    expect(screen.queryByTestId("antd-tooltip")).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("suppresses Tooltip when the account preference hides tooltips", () => {
    hideTooltips = true;

    render(
      <Tooltip title="Helpful">
        <button type="button">Open</button>
      </Tooltip>,
    );

    expect(screen.queryByTestId("antd-tooltip")).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("suppresses Tip popovers when the account preference hides tooltips", () => {
    hideTooltips = true;

    render(
      <Tip title="Title" tip="More context">
        <button type="button">Open</button>
      </Tip>,
    );

    expect(screen.queryByTestId("antd-popover")).toBeNull();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });
});
