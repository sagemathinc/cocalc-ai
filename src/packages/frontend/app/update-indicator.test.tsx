import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UpdatePill, updateUrgency, versionTime } from "./update-indicator";

const mockSetOtherSettings = jest.fn();
let mockIconOnly = false;
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => new Map([["update_indicator_icon_only", mockIconOnly]]),
  redux: {
    getActions: () => ({ set_other_settings: mockSetOtherSettings }),
  },
}));
jest.mock("./frontend-build-monitor", () => ({
  reloadForFrontendBuild: jest.fn(),
  useFrontendBuildMonitor: () => ({ reloadRecommended: false }),
}));

const DAY = 24 * 60 * 60 * 1000;

describe("update indicator", () => {
  it("grows more urgent like Chrome's", () => {
    const now = Date.now();
    expect(updateUrgency("recommended", now - DAY, now)).toBe("low");
    expect(updateUrgency("recommended", now - 2 * DAY, now)).toBe("elevated");
    expect(updateUrgency("recommended", now - 5 * DAY, now)).toBe("high");
    expect(updateUrgency("required", now, now)).toBe("high");
  });

  it("reads build times in seconds or ms", () => {
    expect(versionTime("1791099701123")).toBe(1791099701123);
    expect(versionTime(1791099701)).toBe(1791099701000);
    expect(versionTime("previous")).toBeUndefined();
  });

  it("cannot be dismissed; a click explains, acts and offers the icon form", async () => {
    const onAction = jest.fn();
    mockIconOnly = false;
    const pill = () => (
      <UpdatePill
        level="recommended"
        label="Update"
        description="A new version is available."
        actionLabel="Reload page"
        onAction={onAction}
      />
    );
    const { rerender } = render(pill());
    const user = userEvent.setup();
    // Only the word: no icon, no extra controls, nothing to dismiss.
    const button = screen.getByRole("button", {
      name: "Update: A new version is available.",
    });
    expect(button).toHaveTextContent("Update");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await user.click(button);
    expect(
      await screen.findByText("A new version is available."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show as icon" }));
    expect(mockSetOtherSettings).toHaveBeenCalledWith(
      "update_indicator_icon_only",
      true,
    );
    await user.click(button);
    await user.click(
      await screen.findByRole("button", { name: "Reload page" }),
    );
    expect(onAction).toHaveBeenCalled();
    mockIconOnly = true;
    rerender(pill());
    expect(screen.queryByText("Update")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Update: A new version is available.",
      }),
    ).toBeInTheDocument();
  });
});
