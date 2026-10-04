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

  it("cannot be dismissed, acts on click and can shrink to an icon", async () => {
    const onClick = jest.fn();
    mockIconOnly = false;
    const { rerender } = render(
      <UpdatePill
        level="recommended"
        label="Update"
        description="A new version is available."
        onClick={onClick}
      />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "A new version is available." }),
    );
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByText("Update")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /dismiss|close/i })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Show update as an icon" }),
    );
    expect(mockSetOtherSettings).toHaveBeenCalledWith(
      "update_indicator_icon_only",
      true,
    );
    mockIconOnly = true;
    rerender(
      <UpdatePill
        level="recommended"
        label="Update"
        description="A new version is available."
        onClick={onClick}
      />,
    );
    expect(screen.queryByText("Update")).toBeNull();
    expect(
      screen.getByRole("button", { name: "A new version is available." }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show update label" }),
    ).toBeInTheDocument();
  });
});
