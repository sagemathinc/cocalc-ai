/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { COLORS } from "@cocalc/util/theme";
import { FullscreenButton } from "./fullscreen-button";
import { ConnectionIndicator } from "./connection-indicator";

let fullscreen: string | undefined;
let connection = "connected";
jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  useActions: () => ({}),
  useTypedRedux: (_store, key) =>
    key === "fullscreen" ? fullscreen : connection,
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name, style }) => <span data-testid={name} style={style} />,
  Tip: ({ children }) => children,
}));
jest.mock("./util", () => ({ blur_active_element: jest.fn() }));
const pageStyle = {
  fontSizeIcons: "18px",
  topPaddingIcons: "0",
  sidePaddingIcons: "5px",
} as any;

it("matches the normal navbar foreground and themes the fullscreen exit backing", () => {
  fullscreen = undefined;
  connection = "connected";
  const { rerender } = render(
    <IntlProvider locale="en">
      <FullscreenButton pageStyle={pageStyle} />
      <ConnectionIndicator pageStyle={pageStyle} height={32} />
    </IntlProvider>,
  );
  expect(screen.getByTestId("expand").style.color).toBe(UI_COLORS.text);
  expect(screen.getByTestId("wifi").style.color).toBe(UI_COLORS.text);
  fullscreen = "default";
  rerender(
    <IntlProvider locale="en">
      <FullscreenButton pageStyle={{ ...pageStyle }} />
    </IntlProvider>,
  );
  expect(screen.getByTestId("compress").style.color).toBe(UI_COLORS.text);
  expect(screen.getByTestId("compress").style.background).toBe(
    UI_COLORS.surface,
  );
});

it("retains disconnected warning colors", () => {
  connection = "disconnected";
  render(
    <IntlProvider locale="en">
      <ConnectionIndicator pageStyle={pageStyle} height={32} />
    </IntlProvider>,
  );
  const text = screen.getByText("Disconnected");
  expect(text.style.color).toBe("white");
  expect(text.parentElement).toHaveStyle({
    backgroundColor: COLORS.ANTD_RED_WARN,
  });
});
