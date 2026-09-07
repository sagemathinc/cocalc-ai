import { Map } from "immutable";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntlProvider } from "react-intl";
import { EditorSettingsColorScheme } from "./editor-settings/color-schemes";
import { TerminalSettings } from "./terminal-settings";
import { set_account_table } from "./util";
import { FOLLOW_APPEARANCE } from "@cocalc/util/appearance-editor";

let mockScheme = "cocalc-light";
jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  useTypedRedux: () => Map({ color_scheme: mockScheme }),
}));
jest.mock("./util", () => ({ set_account_table: jest.fn() }));
jest.mock("@cocalc/frontend/misc/async-component", () => ({
  AsyncComponent: () => () => null,
}));
jest.mock("@cocalc/frontend/appearance/use-appearance", () => ({
  useAppearance: () => ({ resolved: "light" }),
}));

describe.each(["editor", "terminal"])("%s color-scheme reset", (kind) => {
  it("resets to Follow by keyboard and disables Reset once selected", async () => {
    mockScheme = "cocalc-light";
    const onChange = jest.fn();
    const content = () => (
      <IntlProvider locale="en">
        {kind === "editor" ? (
          <EditorSettingsColorScheme
            theme={mockScheme}
            on_change={onChange}
            editor_settings={Map()}
          />
        ) : (
          <TerminalSettings />
        )}
      </IntlProvider>
    );
    const { rerender } = render(content());
    const user = userEvent.setup();
    const reset = screen.getByRole("button", { name: "Reset" });
    await user.tab();
    expect(reset).toHaveFocus();
    await user.keyboard("{Enter}");
    if (kind === "editor") {
      expect(onChange).toHaveBeenCalledWith(FOLLOW_APPEARANCE);
    } else {
      expect(set_account_table).toHaveBeenCalledWith({
        terminal: { color_scheme: FOLLOW_APPEARANCE },
      });
    }
    mockScheme = FOLLOW_APPEARANCE;
    rerender(content());
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
  });
});
