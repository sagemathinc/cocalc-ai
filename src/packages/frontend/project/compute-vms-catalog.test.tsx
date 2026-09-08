import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectComputeVms } from "./compute-vms";
import { VM_PREVIEW_CATALOG } from "./compute-vms-preview";

const mockGetCatalog = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        compute: {
          getCatalog: () => mockGetCatalog(),
          listVms: async () => [],
          listVolumes: async () => [],
          listVmProjectAccess: async () => [],
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  ...jest.requireActual("@cocalc/frontend/app-framework"),
  useRedux: () => undefined,
  useTypedRedux: () => undefined,
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  useFreshAuthAction: () => ({ freshAuthModalProps: {} }),
  FreshAuthModal: () => null,
}));
jest.mock("../hosts/hooks/use-host-pricing-settings", () => ({
  useHostPricingSettings: () => ({}),
}));

it("explains catalog failures and recovers dependent controls outside the create modal", async () => {
  const user = userEvent.setup();
  let finish!: (value: unknown) => void;
  mockGetCatalog
    .mockRejectedValueOnce(Error("offline"))
    .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    .mockRejectedValueOnce(Error("refresh failed"));
  render(<ProjectComputeVms />);

  expect(await screen.findByText("Unable to load VM catalog")).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create volume" })).toBeDisabled();
  expect(
    screen.getByText("You do not own any virtual machines."),
  ).toBeVisible();

  screen.getByRole("button", { name: "Retry catalog" }).focus();
  await user.keyboard("{Enter}");
  expect(mockGetCatalog).toHaveBeenCalledTimes(2);
  await act(async () => finish(VM_PREVIEW_CATALOG));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Create volume" })).toBeEnabled(),
  );
  expect(
    screen.queryByText("Unable to load VM catalog"),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await user.click(
    screen.getByRole("button", { name: "Refresh", exact: true }),
  );
  expect(await screen.findByText("Unable to refresh VM catalog")).toBeVisible();
  expect(screen.getByRole("button", { name: "Create volume" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Retry catalog" })).toBeEnabled();
  expect(
    screen.queryByText("Managed compute action failed"),
  ).not.toBeInTheDocument();
});
