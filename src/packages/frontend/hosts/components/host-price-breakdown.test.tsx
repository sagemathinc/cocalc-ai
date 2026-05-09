import { renderToStaticMarkup } from "react-dom/server";
import { HostPriceBreakdown } from "./host-price-breakdown";

describe("HostPriceBreakdown", () => {
  it("shows both hourly and monthly amounts for each line item", () => {
    const html = renderToStaticMarkup(
      <HostPriceBreakdown
        estimate={{
          usd_per_hour: 0.25,
          usd_per_month: 182.5,
          hourly_label: "$0.25/hr",
          monthly_label: "$182.50/mo",
          line_items: [
            {
              key: "vm",
              label: "VM",
              usd_per_hour: 0.2,
              usd_per_month: 146,
              hourly_label: "$0.20/hr",
              monthly_label: "$146.00/mo",
            },
            {
              key: "disk",
              label: "Persistent disk",
              usd_per_hour: 0.05,
              usd_per_month: 36.5,
              hourly_label: "$0.05/hr",
              monthly_label: "$36.50/mo",
            },
          ],
          notes: ["Example note"],
        }}
      />,
    );

    expect(html).toContain("Hourly");
    expect(html).toContain("Monthly");
    expect(html).toContain("$0.20/hr");
    expect(html).toContain("$146.00/mo");
    expect(html).toContain("$0.25/hr");
    expect(html).toContain("$182.50/mo");
  });
});
