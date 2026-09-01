import { render, screen } from "@testing-library/react";

import { COLORS } from "@cocalc/util/theme";
import {
  activeUsersMapDomainColors,
  ActiveUsersMapDomainChart,
} from "./active-users-map-domains";

let plotProps: any;

jest.mock("@cocalc/frontend/components/plotly", () => ({
  __esModule: true,
  default: (props: any) => {
    plotProps = props;
    return <div data-testid="domain-plot" />;
  },
}));

beforeEach(() => {
  plotProps = undefined;
});

describe("ActiveUsersMapDomainChart", () => {
  it("keeps Other neutral and avoids matching colors at the pie seam", () => {
    const withOther = Array.from({ length: 9 }, (_, index) => ({
      domain: index === 8 ? "Other" : `domain-${index}.test`,
      count: 9 - index,
    }));
    expect(activeUsersMapDomainColors(withOther).at(-1)).toBe(COLORS.GRAY);

    const withoutOther = withOther.map((entry, index) => ({
      ...entry,
      domain: `domain-${index}.test`,
    }));
    const colors = activeUsersMapDomainColors(withoutOther);
    expect(colors.at(-1)).not.toBe(colors[0]);
    expect(colors.at(-1)).not.toBe(colors.at(-2));
  });

  it("renders live domain counts with accessible chart details", () => {
    render(
      <ActiveUsersMapDomainChart
        counts={[
          { domain: "example.com", count: 2 },
          { domain: "kernel.org", count: 1 },
        ]}
        total={3}
      />,
    );

    expect(
      screen.getByRole("img", {
        name: "Email domains for 3 active users: example.com, 2; kernel.org, 1.",
      }),
    ).toBeVisible();
    expect(screen.getByTestId("domain-plot")).toBeInTheDocument();
    expect(plotProps.data).toHaveLength(2);
    expect(plotProps.data[0]).toMatchObject({
      labels: ["example.com", "kernel.org"],
      values: [2, 1],
      direction: "clockwise",
      rotation: 135,
      texttemplate: "%{label}",
      textposition: "outside",
    });
    expect(plotProps.data[1]).toMatchObject({
      labels: ["example.com", "kernel.org"],
      values: [2, 1],
      direction: "clockwise",
      rotation: 135,
      texttemplate: "%{value:d}",
      textposition: "inside",
    });
    expect(plotProps.layout.height).toBe(520);
    expect(plotProps.layout.margin).toBeUndefined();
  });
});
