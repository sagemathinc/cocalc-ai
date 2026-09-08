import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VmCreateModal } from "./compute-vms";
import { VM_PREVIEW_CATALOG } from "./compute-vms-preview";
import userEvent from "@testing-library/user-event";

jest.mock("../hosts/hooks/use-host-pricing-settings", () => ({
  useHostPricingSettings: () => ({}),
}));

it("distinguishes loading, unknown failure, and a ready catalog", async () => {
  const user = userEvent.setup();
  const onRetryCatalog = jest.fn();
  const props = {
    open: true,
    catalog: VM_PREVIEW_CATALOG,
    volumes: [],
    initial: {
      ...VM_PREVIEW_CATALOG.defaults,
      name: "Test VM",
      funding_mode: "account-prepaid" as const,
      pricing_model: "on_demand" as const,
      allow_on_demand_fallback: false,
    },
    projectSshPublicKey: null,
    sshKeys: [],
    saving: false,
    preferredR2Region: undefined,
    onCancel: jest.fn(),
    onCreate: jest.fn(),
    onRetryCatalog,
  };
  const { rerender } = render(
    <VmCreateModal
      {...props}
      catalogLoading
      creationUnavailable="Catalog could not be loaded."
    />,
  );
  await waitFor(() =>
    expect(screen.getByText("Loading VM catalog")).toBeVisible(),
  );
  expect(screen.queryByText("VM creation unavailable")).toBeNull();
  expect(screen.queryByText("Catalog could not be loaded.")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Create VM", exact: true }),
  ).toBeDisabled();

  rerender(
    <VmCreateModal
      {...props}
      creationUnavailable="Catalog could not be loaded."
    />,
  );
  expect(screen.getByText("Unable to load VM catalog")).toBeVisible();
  const retry = screen.getByRole("button", { name: "Retry catalog" });
  retry.focus();
  await user.keyboard("{Enter}");
  expect(onRetryCatalog).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Create VM", exact: true }),
  ).toBeDisabled();

  rerender(<VmCreateModal {...props} />);
  expect(screen.queryByText("Unable to load VM catalog")).toBeNull();
  expect(screen.queryByText("Loading VM catalog")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Create VM", exact: true }),
  ).toBeEnabled();
});

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
