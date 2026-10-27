/** @jest-environment jsdom */

import type { HostCatalog } from "@cocalc/conat/hub/api/hosts";
import { React } from "@cocalc/frontend/app-framework";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NebiusCapacityPicker } from "./nebius-capacity-picker";

const catalog: HostCatalog = {
  provider_capabilities: {},
  entries: [
    {
      kind: "regions",
      scope: "global",
      payload: [{ name: "eu-north1" }, { name: "us-central1" }],
    },
    {
      kind: "instance_types",
      scope: "global",
      payload: [
        {
          name: "1gpu-24vcpu-218gb",
          platform: "gpu-rtx6000",
          platform_label: "NVIDIA RTX PRO 6000",
          gpu_label: "NVIDIA RTX PRO 6000",
          allowed_for_preemptibles: true,
          regions: ["eu-north1", "us-central1"],
          vcpus: 24,
          memory_gib: 218,
          gpus: 1,
        },
        {
          name: "16vcpu-64gb",
          platform: "cpu-d3",
          platform_label: "AMD Epyc Genoa",
          allowed_for_preemptibles: false,
          regions: ["eu-north1", "us-central1"],
          vcpus: 16,
          memory_gib: 64,
          gpus: 0,
        },
      ],
    },
    {
      kind: "capacity_advice",
      scope: "global",
      payload: [
        {
          region: "us-central1",
          fabric: "fabric-us",
          platform: "gpu-rtx6000",
          machine_type: "1gpu-24vcpu-218gb",
          spot: {
            available: 28,
            limit: 32,
            availability_level: "high",
            data_state: "fresh",
          },
        },
        {
          region: "eu-north1",
          fabric: "fabric-eu",
          platform: "gpu-rtx6000",
          machine_type: "1gpu-24vcpu-218gb",
          spot: {
            available: 3,
            limit: 8,
            availability_level: "medium",
            data_state: "fresh",
          },
        },
      ],
    },
    {
      kind: "prices",
      scope: "global",
      payload: [
        {
          product: "Preemptible NVIDIA RTX PRO 6000",
          region: "us-central1",
          price_usd: "2",
          unit: "GPU hour",
        },
        {
          product: "Preemptible NVIDIA RTX PRO 6000",
          region: "eu-north1",
          price_usd: "1",
          unit: "GPU hour",
        },
      ],
    },
  ],
};

describe("NebiusCapacityPicker", () => {
  it("requests an unmatched fallback only once when the parent rerenders", async () => {
    const onSelect = jest.fn();

    function UnmatchedSelectionHarness() {
      const [, rerender] = React.useState(0);
      return (
        <NebiusCapacityPicker
          catalog={catalog}
          selection={{
            pricing_model: "spot",
            region: "missing-region",
            machine_type: "missing-machine",
            provider_platform: "missing-platform",
          }}
          onPricingModelChange={jest.fn()}
          onSelect={(option) => {
            onSelect(option);
            rerender((value) => value + 1);
          }}
        />
      );
    }

    render(<UnmatchedSelectionHarness />);

    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
  });

  it("shows unique all-region choices and exposes them to keyboard users", () => {
    const onSelect = jest.fn();
    render(
      <NebiusCapacityPicker
        catalog={catalog}
        selection={{
          pricing_model: "spot",
          region: "us-central1",
          machine_type: "1gpu-24vcpu-218gb",
          provider_platform: "gpu-rtx6000",
        }}
        onPricingModelChange={jest.fn()}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole("radio", { name: "CPU" })).toBeDisabled();
    const priceSort = screen.getByRole("switch", {
      name: "Sort Nebius machines by price",
    });
    expect(priceSort).not.toBeChecked();
    expect(
      screen.getAllByRole("radio", { name: /NVIDIA RTX PRO 6000/i })[0],
    ).toHaveAccessibleName(/us-central1/i);
    for (const price of screen.getAllByText(/\/hr$/)) {
      expect(price.closest(".ant-typography")).toHaveStyle({
        flexShrink: 0,
        whiteSpace: "nowrap",
      });
    }
    fireEvent.click(priceSort);
    expect(priceSort).toBeChecked();
    expect(
      screen.getAllByRole("radio", { name: /NVIDIA RTX PRO 6000/i })[0],
    ).toHaveAccessibleName(/eu-north1/i);
    const usChoice = screen.getByRole("radio", {
      name: /NVIDIA RTX PRO 6000.*us-central1/i,
    });
    const euChoice = screen.getByRole("radio", {
      name: /NVIDIA RTX PRO 6000.*eu-north1/i,
    });
    usChoice.focus();
    expect(usChoice).toHaveFocus();

    fireEvent.click(euChoice);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "eu-north1\u0000gpu-rtx6000\u00001gpu-24vcpu-218gb",
        region: "eu-north1",
      }),
    );
  });

  it("shows Standard CPU catalog choices when capacity is not reported", () => {
    render(
      <NebiusCapacityPicker
        catalog={catalog}
        selection={{
          pricing_model: "on_demand",
          region: "us-central1",
          machine_type: "16vcpu-64gb",
          provider_platform: "cpu-d3",
        }}
        onPricingModelChange={jest.fn()}
        onSelect={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "CPU" }));
    expect(
      screen.getAllByRole("radio", { name: /AMD Epyc Genoa.*16 vCPU/i }),
    ).toHaveLength(2);
    expect(screen.getAllByText("Capacity not reported").length).toBeGreaterThan(
      0,
    );
  });

  it("reports pricing-model changes through a named radio control", () => {
    const onPricingModelChange = jest.fn();
    render(
      <NebiusCapacityPicker
        catalog={catalog}
        selection={{
          pricing_model: "spot",
          region: "us-central1",
          machine_type: "1gpu-24vcpu-218gb",
          provider_platform: "gpu-rtx6000",
        }}
        onPricingModelChange={onPricingModelChange}
        onSelect={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Standard" }));
    expect(onPricingModelChange).toHaveBeenCalledWith("on_demand");
  });

  it("offers Standard only while Nebius Spot is unavailable (#684)", () => {
    const onPricingModelChange = jest.fn();
    render(
      <NebiusCapacityPicker
        catalog={catalog}
        selection={{
          pricing_model: "spot",
          region: "us-central1",
          machine_type: "1gpu-24vcpu-218gb",
          provider_platform: "gpu-rtx6000",
        }}
        onPricingModelChange={onPricingModelChange}
        onSelect={jest.fn()}
      />,
    );
    // a Spot selection moves to Standard, and Spot can't be chosen
    expect(onPricingModelChange).toHaveBeenCalledWith("on_demand");
    expect(screen.getByRole("radio", { name: "Spot" })).toBeDisabled();
    expect(
      screen.getByText("Nebius Spot is unavailable for now; Standard only."),
    ).toBeTruthy();
  });
});
