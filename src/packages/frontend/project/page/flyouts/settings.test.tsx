/** @jest-environment jsdom */

import immutable from "immutable";
import { render, screen } from "@testing-library/react";
import { SettingsFlyout } from "./settings";

jest.mock("antd", () => {
  const Button = ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  );
  const Collapse = ({ items }: any) => (
    <div>
      {items.map((item: any) => (
        <section key={item.key}>
          <div>{item.label}</div>
          <div>{item.children}</div>
        </section>
      ))}
    </div>
  );
  const Space = ({ children }: any) => <div>{children}</div>;
  Space.Compact = ({ children }: any) => <div>{children}</div>;
  return {
    Button,
    Collapse,
    Space,
    Tooltip: ({ children }: any) => <>{children}</>,
  };
});

jest.mock("react-intl", () => ({
  defineMessage: (msg: any) => msg,
  useIntl: () => ({
    formatMessage: (msg: any) => msg?.defaultMessage ?? msg?.id ?? String(msg),
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({
      reload_configuration: jest.fn(),
    }),
    getActions: () => ({}),
  },
  useEffect: require("react").useEffect,
  useState: require("react").useState,
  useTypedRedux: (store: any, key: string) => {
    if (store === "account" && key === "account_id") {
      return "acct-1";
    }
    if (store === "projects" && key === "host_info") {
      return immutable.Map();
    }
    if (store === "page" && key === "active_top_tab") {
      return "project-1";
    }
    if (
      (store as any)?.project_id === "project-1" &&
      key === "configuration_loading"
    ) {
      return false;
    }
    if (store === "customize" && key === "kucalc") {
      return "cocalc-com";
    }
    if (store === "customize" && key === "datastore") {
      return false;
    }
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Loading: () => <div>Loading</div>,
  Title: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/course", () => ({
  useStudentProjectFunctionality: () => ({ disableSSH: false }),
  getStudentProjectFunctionality: () => ({ disableSSH: false }),
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  isIntlMessage: (msg: any) => !!msg && typeof msg === "object",
  labels: {
    ssh_keys: { defaultMessage: "SSH Keys" },
  },
}));

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({
    status: immutable.Map({ state: "running" }),
    project: immutable.Map({
      title: "Project",
      description: "",
      created: 1,
      name: "project",
      host_id: null,
    }),
  }),
}));

jest.mock("@cocalc/frontend/project/settings/about-box", () => ({
  AboutBox: () => <div>AboutBox</div>,
}));
jest.mock("@cocalc/frontend/project/settings/api-keys", () => ({
  ApiKeys: () => <div>ApiKeys</div>,
}));
jest.mock("@cocalc/frontend/project/backups/create", () => ({
  __esModule: true,
  default: () => <button type="button">Create Backup</button>,
}));
jest.mock("@cocalc/frontend/project/explorer/clone", () => ({
  __esModule: true,
  default: () => <button type="button">Clone</button>,
}));
jest.mock("@cocalc/frontend/project/settings/datastore", () => ({
  Datastore: () => <div>Datastore</div>,
}));
jest.mock("@cocalc/frontend/project/settings/environment", () => ({
  ENV_VARS_ICON: "terminal",
  Environment: () => <div>Environment</div>,
}));
jest.mock("@cocalc/frontend/project/settings/hide-delete-box", () => ({
  HideDeleteBox: () => <div>HideDeleteBox</div>,
}));
jest.mock("@cocalc/frontend/project/settings/project-capabilites", () => ({
  ProjectCapabilities: () => <div>ProjectCapabilities</div>,
}));
jest.mock("@cocalc/frontend/project/settings/project-control", () => ({
  ProjectControl: () => <div>ProjectControl</div>,
}));
jest.mock("@cocalc/frontend/project/settings/restart-project", () => ({
  RestartProject: () => <button type="button">Restart</button>,
}));
jest.mock("@cocalc/frontend/project/settings/move-project", () => ({
  __esModule: true,
  default: () => <button type="button">Move</button>,
}));
jest.mock("@cocalc/frontend/project/snapshots/create", () => ({
  __esModule: true,
  default: () => <button type="button">Create Snapshot</button>,
}));
jest.mock("@cocalc/frontend/project/settings/ssh", () => ({
  SSHPanel: () => <div>SSHPanel</div>,
}));
jest.mock("@cocalc/frontend/project/settings/stop-project", () => ({
  StopProject: () => <button type="button">Stop</button>,
}));
jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));
jest.mock("@cocalc/frontend/project/page/flyouts/state", () => ({
  getFlyoutSettings: () => [],
  storeFlyoutState: jest.fn(),
}));
jest.mock("@cocalc/frontend/project/settings/project-control-error", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@cocalc/frontend/projects/host-operational", () => ({
  normalizeProjectStateForDisplay: ({ projectState }: any) => projectState,
}));

describe("SettingsFlyout", () => {
  it("includes recovery actions in flyout settings", () => {
    render(
      <SettingsFlyout
        project_id="project-1"
        wrap={(content) => <>{content}</>}
      />,
    );

    expect(screen.getByText("Recovery and Copy")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create Snapshot" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Backup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clone" })).toBeTruthy();
  });

  it("shows SSH before Hide or Delete in flyout settings", () => {
    const { container } = render(
      <SettingsFlyout
        project_id="project-1"
        wrap={(content) => <>{content}</>}
      />,
    );

    const text = container.textContent ?? "";
    expect(text.indexOf("SSH")).toBeGreaterThan(-1);
    expect(text.indexOf("Hide or Delete")).toBeGreaterThan(-1);
    expect(text.indexOf("SSH")).toBeLessThan(text.indexOf("Hide or Delete"));
  });
});
