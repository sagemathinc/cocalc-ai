import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { VmCreateModal } from "./compute-vms";
import { VM_PREVIEW_CATALOG } from "./compute-vms-preview";

jest.mock("../hosts/hooks/use-host-pricing-settings", () => ({
  useHostPricingSettings: () => ({}),
}));

it("opens the real VM form without a catalog but blocks creation", () => {
  const onCreate = jest.fn();
  const onCancel = jest.fn();
  const { rerender } = render(
    <VmCreateModal
      open
      catalog={VM_PREVIEW_CATALOG}
      creationUnavailable="An administrator must configure managed compute."
      volumes={[]}
      initial={{
        ...VM_PREVIEW_CATALOG.defaults,
        name: "",
        funding_mode: "account-prepaid",
        pricing_model: "on_demand",
        allow_on_demand_fallback: false,
      }}
      projectSshPublicKey={null}
      sshKeys={[]}
      saving={false}
      preferredR2Region={undefined}
      onCancel={onCancel}
      onCreate={onCreate}
    />,
  );
  expect(
    screen.getByRole("dialog", { name: "Create virtual machine" }),
  ).toBeInTheDocument();
  expect(screen.getByText(/administrator must configure/i)).toBeInTheDocument();
  const create = screen.getByRole("button", { name: "Create VM", exact: true });
  expect(create).toBeDisabled();
  fireEvent.click(create);
  expect(onCreate).not.toHaveBeenCalled();
  const title = screen.getByRole("textbox", { name: "VM title" });
  fireEvent.change(title, { target: { value: "Preview" } });
  expect(title).toHaveValue("Preview");
  fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  expect(onCancel).toHaveBeenCalled();
  rerender(<></>);
});
