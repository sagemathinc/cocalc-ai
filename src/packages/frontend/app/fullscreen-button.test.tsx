/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { FullscreenButton } from "./fullscreen-button";

let fullscreen: string | undefined;
const toggle_fullscreen = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  useActions: () => ({ toggle_fullscreen }),
  useTypedRedux: () => fullscreen,
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name, onClick, ...props }) => (
    <span
      data-testid={name}
      onClick={onClick}
      aria-label={props["aria-label"]}
    />
  ),
  Tip: ({ children }) => children,
}));

const pageStyle = { fontSizeIcons: "18px" } as any;
const renderButton = () =>
  render(
    <IntlProvider locale="en">
      <FullscreenButton pageStyle={pageStyle} />
    </IntlProvider>,
  );

beforeEach(() => toggle_fullscreen.mockClear());

it("shows a labeled exit button in default fullscreen", () => {
  fullscreen = "default";
  renderButton();
  fireEvent.click(screen.getByRole("button", { name: /exit fullscreen/i }));
  expect(toggle_fullscreen).toHaveBeenCalledTimes(1);
});

it("shows the enter icon outside fullscreen", () => {
  fullscreen = undefined;
  renderButton();
  expect(screen.queryByRole("button", { name: /exit fullscreen/i })).toBeNull();
  fireEvent.click(screen.getByTestId("expand"));
  expect(toggle_fullscreen).toHaveBeenCalledTimes(1);
});

it.each(["kiosk", "project"])("renders no control in %s mode", (mode) => {
  fullscreen = mode;
  const { container } = renderButton();
  expect(container).toBeEmptyDOMElement();
});
