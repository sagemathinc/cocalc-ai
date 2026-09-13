import "@testing-library/jest-dom";
import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComputeVolume } from "@cocalc/conat/hub/api/compute";
import {
  VolumeCreateModal,
  VolumeResizeModal,
  VmCreateModal,
} from "./compute-vms";
import VolumeFundingStatus from "./compute-volume-funding-status";
import {
  volumeFundingUnavailable,
  volumeResizeFunding,
} from "./compute-volume-funding";
import { catalog } from "@cocalc/frontend/course/test/course-vm-template-fixture";

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
        compute: {
          getCatalog: async () => ({
            ...catalog,
            sponsored_home_volumes: true,
          }),
        },
        computeFunding: {
          listSources: async () => ({
            as_of: new Date().toISOString(),
            sources: [
              {
                ...source,
                label: "Course storage",
                lane: "prepaid",
                state: "active",
                pool_state: "active",
                available_for_new_resources: true,
                available_usd: "50",
                starts_at: "2020-01-01T00:00:00Z",
                ends_at: "2099-01-01T00:00:00Z",
                authorized_usd: "50",
                spent_usd: "0",
                reserved_usd: "0",
                released_usd: "0",
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

beforeEach(() => {
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
});
afterEach(() => jest.restoreAllMocks());
function volume(): ComputeVolume {
  return {
    id: "volume-id",
    name: "course-home",
    owner_account_id: "independent-owner",
    provider: "gcp",
    region: "us-west1",
    zone: "us-west1-a",
    state: "ready",
    desired_state: "ready",
    size_gb: 50,
    effective_size_gb: 50,
    attachment_state: "detached",
    monthly_price_per_gb: "0.1",
    funding_mode: "account-prepaid",
    funding_source: source,
    funding_status: {
      source,
      payer_account_id: source.payer_account_id,
      label: "Course storage",
      state: "running",
      funding_version: "volume-epoch",
      spent_usd: "1",
      committed_usd: "8",
      protected_storage_usd: "2",
      authorized_until: new Date(Date.now() + 3600000).toISOString(),
      storage_delete_at: new Date(Date.now() + 7200000).toISOString(),
      as_of: new Date().toISOString(),
    },
  } as ComputeVolume;
}
async function selectCourse() {
  const select = screen.getByRole("combobox", { name: "Course funding" });
  act(() => select.focus());
  fireEvent.keyDown(select, { key: "ArrowDown", keyCode: 40, which: 40 });
  await screen.findAllByText(/Course storage.*available to start/);
  fireEvent.keyDown(select, { key: "ArrowDown", keyCode: 40, which: 40 });
  fireEvent.keyDown(select, { key: "Enter", keyCode: 13, which: 13 });
  return await screen.findByRole("checkbox", {
    name: /I accept this home volume/,
  });
}

it("shows independent owner, payer, storage amounts and retention deadlines", () => {
  render(<VolumeFundingStatus volume={volume()} />);
  const section = screen.getByRole("region", {
    name: "Funding for home volume course-home",
  });
  expect(within(section).getByText("independent-owner")).toBeVisible();
  expect(within(section).getAllByText("Course storage")).toHaveLength(2);
  expect(within(section).getByText("Committed to this volume")).toBeVisible();
  expect(within(section).getByText("Volume deletion deadline")).toBeVisible();
  expect(
    within(section).getByText(/Deleting the VM does not delete/),
  ).toBeVisible();
});
it("redacted payer keeps labeled storage usable and submits only its reviewed funding version", async () => {
  const user = userEvent.setup();
  const current = volume();
  const publicSource = {
    kind: source.kind,
    pool_id: source.pool_id,
    grant_id: source.grant_id,
  };
  current.funding_source = publicSource;
  current.funding_status = {
    ...current.funding_status!,
    source: publicSource,
    payer_account_id: undefined,
    label: "Course funding",
    state: "ready",
    stop_at: new Date(Date.now() + 3600000).toISOString(),
  };
  const onResize = jest.fn();
  render(
    <VolumeResizeModal
      volume={current}
      sponsoredHomeVolumes
      maxSizeGb={1000}
      saving={false}
      onCancel={jest.fn()}
      onResize={onResize}
    />,
  );
  expect(screen.getAllByText("Course funding")).toHaveLength(2);
  expect(
    screen.queryByText(
      "Volume funding status is unavailable, expired, or out of date.",
    ),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(source.payer_account_id)).not.toBeInTheDocument();
  expect(volumeFundingUnavailable(current)).toBe(false);
  expect(volumeResizeFunding(current)).toEqual({
    expected_funding_version: "volume-epoch",
  });
  const input = screen.getByRole("spinbutton", { name: "New size (GB)" });
  await user.clear(input);
  await user.type(input, "100");
  await user.click(screen.getByRole("button", { name: "Enlarge volume" }));
  await waitFor(() => expect(onResize).toHaveBeenCalledTimes(1));
});
it("unknown course status stays unavailable and never displays personal funding or zero amounts", () => {
  const current = volume();
  current.funding_status = undefined;
  render(<VolumeFundingStatus volume={current} />);
  expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
  expect(screen.queryByText("Personal funding")).not.toBeInTheDocument();
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  expect(volumeFundingUnavailable(current)).toBe(true);
  expect(() => volumeResizeFunding(current)).toThrow("funding is unavailable");
});
it("legacy personal storage retains its original owner as payer", () => {
  const current = volume();
  current.funding_status = undefined;
  current.funding_source = undefined;
  render(<VolumeFundingStatus volume={current} />);
  expect(screen.getByText("Personal funding")).toBeVisible();
  expect(volumeResizeFunding(current)).toEqual({});
});
it("keyboard selection and explicit retention acknowledgment reach the real volume form caller", async () => {
  const user = userEvent.setup();
  const onCreate = jest.fn();
  render(
    <VolumeCreateModal
      open
      catalog={{ ...catalog, sponsored_home_volumes: true }}
      saving={false}
      onCancel={jest.fn()}
      onCreate={onCreate}
    />,
  );
  const checkbox = await selectCourse();
  const submit = screen.getByRole("button", { name: "Create volume" });
  expect(submit).toBeDisabled();
  act(() => checkbox.focus());
  await user.keyboard("[Space]");
  await waitFor(() => expect(submit).toBeEnabled());
  await user.click(submit);
  await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  expect(onCreate.mock.calls[0][0]).toMatchObject({
    name: "home-data",
    funding_source: source,
    accept_course_retention: true,
    size_gb: 50,
  });
});
it("an unsupported backend keeps course creation blocked after acknowledgment", async () => {
  const user = userEvent.setup();
  const onCreate = jest.fn();
  render(
    <VolumeCreateModal
      open
      catalog={catalog}
      saving={false}
      onCancel={jest.fn()}
      onCreate={onCreate}
    />,
  );
  const checkbox = await selectCourse();
  await user.click(checkbox);
  expect(
    screen.getByText(
      /Course-funded home volumes are unavailable on this server/,
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Create volume" })).toBeDisabled();
  expect(onCreate).not.toHaveBeenCalled();
});

it("reopening a fresh volume draft clears the previous payer and retention acknowledgment", async () => {
  const user = userEvent.setup();
  const onCreate = jest.fn();
  const props = {
    catalog: { ...catalog, sponsored_home_volumes: true },
    saving: false,
    onCancel: jest.fn(),
    onCreate,
  };
  const { rerender } = render(<VolumeCreateModal open {...props} />);
  await user.click(await selectCourse());
  rerender(<VolumeCreateModal open={false} {...props} />);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  rerender(<VolumeCreateModal open {...props} />);
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Course funding" }).parentElement,
    ).toHaveTextContent("Use my own funding"),
  );
  expect(
    screen.queryByRole("checkbox", { name: /I accept this home volume/ }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Create volume" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
  expect(onCreate.mock.calls[0][0].funding_source).toBeUndefined();
  expect(onCreate.mock.calls[0][0].accept_course_retention).not.toBe(true);
});
it("resize shows the independent payer and cannot submit unknown funding", async () => {
  const current = volume();
  current.funding_status = undefined;
  render(
    <VolumeResizeModal
      volume={current}
      sponsoredHomeVolumes
      maxSizeGb={1000}
      saving={false}
      onCancel={jest.fn()}
      onResize={jest.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByText(source.payer_account_id)).toBeVisible(),
  );
  expect(
    screen.getByRole("spinbutton", { name: "New size (GB)" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "Enlarge volume" })).toBeDisabled();
});
it("Escape cancels the volume dialog and restores focus to its opener", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>New home volume</button>
        <VolumeCreateModal
          open={open}
          catalog={catalog}
          saving={false}
          onCancel={() => setOpen(false)}
          onCreate={async () => {}}
        />
      </>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "New home volume" });
  await user.click(opener);
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(opener).toHaveFocus());
});
it("the actual VM form blocks unsupported combined course creation before either caller", async () => {
  const onCreate = jest.fn();
  render(
    <VmCreateModal
      open
      catalog={catalog}
      volumes={[]}
      initial={{
        ...catalog.defaults,
        name: "vm",
        funding_mode: "account-prepaid",
        funding_source: source,
        pricing_model: "on_demand",
        allow_on_demand_fallback: false,
        create_home_volume: true,
        new_home_volume_name: "home",
        new_home_volume_size_gb: 50,
        accept_course_retention: true,
      }}
      projectSshPublicKey={null}
      sshKeys={[]}
      saving={false}
      preferredR2Region={undefined}
      onCancel={jest.fn()}
      onCreate={onCreate}
    />,
  );
  await waitFor(() =>
    expect(
      screen
        .getAllByText(
          /Course-funded home volumes are unavailable on this server/,
        )
        .some((element) => element.closest('[aria-hidden="true"]') == null),
    ).toBe(true),
  );
  expect(
    screen.getByRole("button", { name: "Create VM", exact: true }),
  ).toBeDisabled();
  expect(onCreate).not.toHaveBeenCalled();
});

it.each(["new", "existing"])(
  "the actual VM form reviews %s storage independently before its caller",
  async (kind) => {
    const user = userEvent.setup();
    const onCreate = jest.fn();
    render(
      <VmCreateModal
        open
        catalog={{ ...catalog, sponsored_home_volumes: true }}
        volumes={kind === "existing" ? [volume()] : []}
        initial={{
          ...catalog.defaults,
          name: "cpu",
          funding_mode: "account-prepaid",
          funding_source: kind === "new" ? source : undefined,
          pricing_model: "on_demand",
          allow_on_demand_fallback: false,
          use_project_ssh_key: false,
          ssh_public_key: "",
          configure_project_ssh: false,
          stop_after_minutes: 90,
          create_home_volume: kind === "new",
          home_volume: kind === "existing" ? "course-home" : undefined,
          new_home_volume_name: "home",
          new_home_volume_size_gb: 50,
          accept_course_retention: true,
        }}
        projectSshPublicKey={null}
        sshKeys={[]}
        saving={false}
        preferredR2Region={undefined}
        onCancel={jest.fn()}
        onCreate={onCreate}
      />,
    );
    const submit = screen.getByRole("button", {
      name: "Create VM",
      exact: true,
    });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Create VM", exact: true }),
      ).toHaveLength(2),
    );
    if (kind === "new") {
      await waitFor(() =>
        expect(
          screen.getByText(
            /Deletion permanently removes software and data on this VM/,
          ),
        ).toBeVisible(),
      );
      expect(
        screen.getByText(/VM files are not backed up automatically/),
      ).toBeVisible();
    }
    await user.click(
      screen.getAllByRole("button", { name: "Create VM", exact: true })[1],
    );
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0][0]).toMatchObject({
      funding_source: kind === "new" ? source : undefined,
      create_home_volume: kind === "new",
      stop_after_minutes: 90,
      ...(kind === "new"
        ? { accept_course_retention: true, new_home_volume_name: "home" }
        : {
            home_volume: "course-home",
            expected_home_volume_funding_version: "volume-epoch",
          }),
    });
  },
);
