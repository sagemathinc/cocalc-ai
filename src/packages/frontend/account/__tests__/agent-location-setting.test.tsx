import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Map as ImmutableMap } from "immutable";

const setOtherSettings = jest.fn();
let mockOtherSettings = ImmutableMap<string, unknown>();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({ set_other_settings: setOtherSettings }),
  },
  useTypedRedux: () => mockOtherSettings,
}));

import { AgentLocationSetting } from "../agent-location-setting";

describe("AgentLocationSetting", () => {
  beforeEach(() => {
    setOtherSettings.mockReset();
    mockOtherSettings = ImmutableMap();
  });

  it("is on by default and can be turned off", async () => {
    render(<AgentLocationSetting />);
    const toggle = screen.getByRole("switch", {
      name: "Let agents use my approximate location",
    });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(setOtherSettings).toHaveBeenCalledWith(
      "agent_location_metadata",
      false,
    );
  });

  it("shows the saved choice", () => {
    mockOtherSettings = ImmutableMap({ agent_location_metadata: false });
    render(<AgentLocationSetting />);
    expect(
      screen.getByRole("switch", {
        name: "Let agents use my approximate location",
      }),
    ).not.toBeChecked();
  });
});
