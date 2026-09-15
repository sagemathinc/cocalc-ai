import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VmCreateModal } from "./compute-vms";
import {
  catalog,
  template,
} from "@cocalc/frontend/course/test/course-vm-template-fixture";

const mockGetCatalog = jest.fn();
const source = {
  kind: "course" as const,
  payer_account_id: "11111111-1111-4111-8111-111111111111",
  pool_id: "22222222-2222-4222-8222-222222222222",
  grant_id: "33333333-3333-4333-8333-333333333333",
};
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        compute: { getCatalog: () => mockGetCatalog() },
        computeFunding: {
          listSources: async () => ({
            as_of: new Date().toISOString(),
            sources: [
              {
                ...source,
                label: "Course credit",
                lane: "prepaid",
                state: "active",
                pool_state: "active",
                available_for_new_resources: true,
                available_usd: "50",
                starts_at: "2026-01-01T00:00:00Z",
                ends_at: "2030-01-01T00:00:00Z",
                authorized_usd: "50",
                spent_usd: "0",
                reserved_usd: "0",
                released_usd: "0",
                recommended_vm_templates: [template],
              },
            ],
          }),
        },
      },
    },
  },
}));
jest.mock("../hosts/hooks/use-host-pricing-settings", () => ({
  useHostPricingSettings: () => ({}),
}));

it("carries a selected recommendation through the real create form without changing funding, keys or deadlines", async () => {
  const user = userEvent.setup();
  const onCreate = jest.fn();
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
  let finish!: (value: typeof catalog) => void;
  mockGetCatalog.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <VmCreateModal
      open
      catalog={catalog}
      volumes={[]}
      initial={{
        ...catalog.defaults,
        name: "course-vm",
        machine_type: "e2-standard-4",
        funding_mode: "account-prepaid",
        funding_source: source,
        pricing_model: "on_demand",
        allow_on_demand_fallback: false,
        stop_after_minutes: 90,
        ttl_minutes: 1440,
        use_project_ssh_key: false,
        ssh_public_key: "preserved-public-key",
        configure_project_ssh: false,
      }}
      projectSshPublicKey={null}
      sshKeys={[]}
      saving={false}
      preferredR2Region={undefined}
      onCancel={jest.fn()}
      onCreate={onCreate}
    />,
  );
  const select = await screen.findByRole("combobox", {
    name: "Recommended VM configuration",
  });
  act(() => select.focus());
  fireEvent.keyDown(select, { key: "ArrowDown", keyCode: 40, which: 40 });
  await screen.findAllByText("Notebook CPU");
  fireEvent.keyDown(select, { key: "ArrowDown", keyCode: 40, which: 40 });
  fireEvent.keyDown(select, { key: "Enter", keyCode: 13, which: 13 });
  await waitFor(() => expect(mockGetCatalog).toHaveBeenCalledTimes(1));
  expect(
    screen.getByRole("button", { name: "Create VM", exact: true }),
  ).toBeDisabled();
  await act(async () => finish(catalog));
  await screen.findByText(/Current estimate:/);
  await user.click(
    screen.getByRole("button", { name: "Create VM", exact: true }),
  );
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: "Create VM", exact: true }),
    ).toHaveLength(2),
  );
  await user.click(
    screen.getAllByRole("button", { name: "Create VM", exact: true })[1],
  );
  await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  expect(onCreate.mock.calls[0][0]).toMatchObject({
    ...template.config,
    name: "course-vm",
    funding_source: source,
    funding_mode: "account-prepaid",
    stop_after_minutes: 90,
    ttl_minutes: 1440,
    ssh_public_key: "preserved-public-key",
  });
  jest.restoreAllMocks();
});
