/** @jest-environment jsdom */

import { act, render, screen } from "@testing-library/react";
import { PROJECT_SECRETS_DOCS_ACTION_EVENT } from "@cocalc/frontend/project/docs-actions";
import { EnvironmentConfigurationSummary } from "./environment-configuration-summary";

jest.mock("antd", () => {
  const Div = ({ children }: any) => <div>{children}</div>;
  return {
    Button: ({ children, onClick }: any) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
    Card: Div,
    Space: Div,
    Tag: Div,
    Typography: { Text: Div },
  };
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({
      set_other_settings: jest.fn(),
    }),
  },
  useTypedRedux: () => undefined,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
}));

jest.mock("@cocalc/frontend/editor-tmp", () => ({
  file_options: () => ({ name: "Notebook" }),
}));

jest.mock("@cocalc/frontend/project/use-project-env", () => ({
  useProjectEnv: () => ({ env: {} }),
}));

jest.mock("@cocalc/frontend/project/use-project-secrets", () => ({
  useProjectSecrets: () => ({ secrets: [] }),
}));

jest.mock("../new/launcher-catalog", () => ({
  QUICK_CREATE_MAP: {},
}));

jest.mock("../new/launcher-customize-modal", () => ({
  LauncherCustomizeModal: () => null,
}));

jest.mock("../new/launcher-preferences", () => ({
  getAccountLauncherPrefs: () => null,
  getEffectiveLauncher: () => ({ quickCreate: [] }),
  getSiteLauncherDefaults: () => [],
  LAUNCHER_SETTINGS_KEY: "launcher",
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY: "launcher-defaults",
  updateAccountLauncherPrefs: () => ({}),
}));

jest.mock("./environment", () => ({
  EnvironmentVariablesModal: () => null,
}));

jest.mock("./secrets", () => ({
  ProjectSecretsModal: ({ open }: any) =>
    open ? <div data-testid="project-secrets-modal" /> : null,
}));

describe("EnvironmentConfigurationSummary", () => {
  it("opens only the targeted settings surface for project secrets docs actions", () => {
    render(
      <>
        <EnvironmentConfigurationSummary
          mode="project"
          project_id="project-1"
        />
        <EnvironmentConfigurationSummary mode="flyout" project_id="project-1" />
      </>,
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(PROJECT_SECRETS_DOCS_ACTION_EVENT, {
          detail: { projectId: "project-1", surface: "flyout" },
        }),
      );
    });

    expect(screen.getAllByTestId("project-secrets-modal")).toHaveLength(1);
  });
});
