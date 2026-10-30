/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  Icon: ({ name }) => <span data-testid={name} />,
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

it("exits by keyboard and moves focus to the enter button", async () => {
  const user = userEvent.setup();
  fullscreen = "default";
  const { rerender } = renderButton();
  const exit = screen.getByRole("button", { name: /exit fullscreen/i });
  exit.focus();
  await user.keyboard("{Enter}");
  expect(toggle_fullscreen).toHaveBeenCalledTimes(1);
  // the page store leaves fullscreen: the exit button unmounts
  fullscreen = undefined;
  // (new props stand in for the store subscription that re-renders it)
  rerender(
    <IntlProvider locale="en">
      <FullscreenButton pageStyle={{ ...pageStyle }} />
    </IntlProvider>,
  );
  expect(screen.queryByRole("button", { name: /exit fullscreen/i })).toBeNull();
  expect(
    screen.getByRole("button", { name: /enter fullscreen/i }),
  ).toHaveFocus();
});

it("enters by keyboard from a focusable button", async () => {
  const user = userEvent.setup();
  fullscreen = undefined;
  renderButton();
  const enter = screen.getByRole("button", { name: /enter fullscreen/i });
  // a plain mount (no exit just before) does not take focus
  expect(enter).not.toHaveFocus();
  await user.tab();
  expect(enter).toHaveFocus();
  await user.keyboard(" ");
  expect(toggle_fullscreen).toHaveBeenCalledTimes(1);
});

it("on narrow layouts, focuses the marked app-shell control after exit", async () => {
  const user = userEvent.setup();
  fullscreen = "default";
  // narrow: the page renders the button only in fullscreen, and no enter
  // button replaces it; the compact nav's marked control is there instead
  const Narrow = () => (
    <IntlProvider locale="en">
      <nav className="smc-top-bar">
        <button>Projects</button>
        <button data-fullscreen-exit-focus="">More navigation</button>
      </nav>
      {fullscreen && <FullscreenButton pageStyle={{ ...pageStyle }} />}
    </IntlProvider>
  );
  const { rerender } = render(<Narrow />);
  screen.getByRole("button", { name: /exit fullscreen/i }).focus();
  await user.keyboard("{Enter}");
  fullscreen = undefined;
  rerender(<Narrow />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "More navigation" }),
    ).toHaveFocus(),
  );
});

it("renders no second exit control where it is enter-only", () => {
  fullscreen = "default";
  const { container } = render(
    <IntlProvider locale="en">
      <FullscreenButton pageStyle={pageStyle} enterOnly />
    </IntlProvider>,
  );
  expect(container).toBeEmptyDOMElement();
  fullscreen = undefined;
  render(
    <IntlProvider locale="en">
      <FullscreenButton pageStyle={pageStyle} enterOnly />
    </IntlProvider>,
  );
  expect(
    screen.getByRole("button", { name: /enter fullscreen/i }),
  ).toBeInTheDocument();
});

it.each(["kiosk", "project"])("renders no control in %s mode", (mode) => {
  fullscreen = mode;
  const { container } = renderButton();
  expect(container).toBeEmptyDOMElement();
});
