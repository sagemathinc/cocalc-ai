import "@testing-library/jest-dom";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  expect(screen.getByRole("checkbox", { name: "Stop after" })).toBeChecked();
  expect(
    screen.getByRole("spinbutton", { name: "Stop after hours" }),
  ).toHaveValue("6");
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

it("waits for course projects before applying the course-funded default", async () => {
  const user = userEvent.setup();
  const initial = {
    ...VM_PREVIEW_CATALOG.defaults,
    name: "Course VM",
    funding_mode: "account-prepaid" as const,
    funding_source: {
      kind: "course" as const,
      payer_account_id: "instructor",
      pool_id: "pool",
      grant_id: "grant",
    },
    pricing_model: "on_demand" as const,
    allow_on_demand_fallback: false,
  };
  const props = {
    open: true,
    catalog: VM_PREVIEW_CATALOG,
    volumes: [],
    initial,
    projectSshPublicKey: null,
    sshKeys: [],
    saving: false,
    preferredR2Region: undefined,
    onCancel: jest.fn(),
    onCreate: jest.fn(),
  };
  const projects = [
    { project_id: "course-a", title: "Course A", course: true },
    { project_id: "personal", title: "Personal", course: false },
    { project_id: "course-b", title: "Course B", course: true },
  ];
  const { rerender } = render(
    <VmCreateModal {...props} connectedProjects={[]} />,
  );
  const dialog = screen.getByRole("dialog", { name: "Create Course VM" });
  await waitFor(() =>
    expect(within(dialog).getByText("0 Connected Projects...")).toBeVisible(),
  );

  rerender(<VmCreateModal {...props} connectedProjects={projects} />);
  expect(
    await within(dialog).findByText("2 Connected Projects..."),
  ).toBeVisible();

  await user.click(within(dialog).getByText("2 Connected Projects..."));
  await user.click(screen.getByRole("button", { name: /unselect all/i }));
  expect(within(dialog).getByText("0 Connected Projects...")).toBeVisible();

  rerender(<VmCreateModal {...props} connectedProjects={[...projects]} />);
  expect(within(dialog).getByText("0 Connected Projects...")).toBeVisible();
});
