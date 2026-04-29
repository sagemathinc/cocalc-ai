import { fireEvent, render, screen } from "@testing-library/react";
import { React } from "@cocalc/frontend/app-framework";
import { HostPlacementSummary, HostPressureTag } from "./pressure-ui";

describe("host pressure ui", () => {
  it("shows normal placement when requested", () => {
    render(
      <HostPlacementSummary
        host={{ can_place: true, pressure: { zone: "normal" } }}
        showNormal
      />,
    );

    expect(screen.getByText("Placement normal")).toBeTruthy();
    expect(
      screen.getByText(
        "Auto placement currently considers this host a normal candidate.",
      ),
    ).toBeTruthy();
  });

  it("shows blocked placement reasons", () => {
    render(
      <HostPlacementSummary
        host={{
          can_place: false,
          reason_unavailable: "Host heartbeat is stale; host appears offline.",
          pressure: { zone: "observe", reason: "Memory usage is rising." },
        }}
        showNormal
      />,
    );

    expect(screen.getByText("Placement blocked")).toBeTruthy();
    expect(
      screen.getByText("Host heartbeat is stale; host appears offline."),
    ).toBeTruthy();
  });

  it("shows placement details in a popover for compact list usage", async () => {
    render(
      <HostPlacementSummary
        host={{ can_place: true, pressure: { zone: "normal" } }}
        detailMode="popover"
        showNormal
      />,
    );

    expect(screen.getByText("Placement normal")).toBeTruthy();
    expect(
      screen.queryByText(
        "Auto placement currently considers this host a normal candidate.",
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Why?" }));

    expect(
      await screen.findByText(
        "Auto placement currently considers this host a normal candidate.",
      ),
    ).toBeTruthy();
  });

  it("shows the pressure tag for non-normal pressure zones", () => {
    render(<HostPressureTag pressure={{ zone: "pressure" }} />);
    expect(screen.getByText("Pressure")).toBeTruthy();
  });
});
