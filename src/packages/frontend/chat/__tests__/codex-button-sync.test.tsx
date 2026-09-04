/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  writeCachedCodexModelCatalog,
  writeCachedCodexUsageStatus,
} from "@cocalc/frontend/account/codex-usage";
import {
  CodexConfigButton,
  codexModelOptionsForCatalog,
  codexThreadConfigKey,
} from "../codex";

const getCodexUsageStatus = jest.fn();
const stableForm = {
  resetFields: jest.fn(),
  setFieldsValue: jest.fn(),
  getFieldsValue: jest.fn(() => ({})),
};

jest.mock("antd", () => {
  const React = require("react");
  const Radio = ({ children }: any) => <label>{children}</label>;
  Radio.Group = ({ children }: any) => <div>{children}</div>;
  return {
    __esModule: true,
    Alert: ({ children, description, title }: any) => (
      <div>
        {title}
        {description}
        {children}
      </div>
    ),
    Button: ({ children, onClick }: any) => (
      <button onClick={onClick}>{children}</button>
    ),
    Divider: () => <div />,
    Dropdown: ({ children, menu }: any) => {
      const [open, setOpen] = React.useState(false);
      const child = React.Children.only(children);
      return (
        <span>
          {React.cloneElement(child, {
            onClick: (event: any) => {
              child.props.onClick?.(event);
              setOpen((value: boolean) => !value);
            },
          })}
          {open ? (
            <div role="menu">
              {menu?.items?.map((item: any) => (
                <button
                  key={item.key}
                  disabled={item.disabled}
                  onClick={(event) =>
                    menu?.onClick?.({ domEvent: event, key: item.key })
                  }
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </span>
      );
    },
    Input: () => <input />,
    Modal: ({ open, children }: any) => (open ? <div>{children}</div> : null),
    Popover: ({ children }: any) => <>{children}</>,
    Progress: ({ "aria-label": ariaLabel }: any) => (
      <div aria-label={ariaLabel} />
    ),
    Radio,
    Select: ({ value }: any) => <div>{String(value ?? "")}</div>,
    Space: ({ children }: any) => <div>{children}</div>,
    Tag: ({ children }: any) => <span>{children}</span>,
    Tooltip: ({ children }: any) => <div>{children}</div>,
    Typography: {
      Text: ({ children }: any) => <span>{children}</span>,
    },
    Form: Object.assign(({ children }: any) => <div>{children}</div>, {
      useForm: () => [stableForm],
      useWatch: () => undefined,
      Item: ({ children }: any) => <div>{children}</div>,
    }),
  };
});

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  const { TypedMap, createTypedMap } = require("@cocalc/util/redux/TypedMap");
  return {
    React,
    useEffect: React.useEffect,
    useMemo: React.useMemo,
    useState: React.useState,
    useAccountOtherSetting: () => undefined,
    useTypedRedux: () => undefined,
    TypedMap,
    createTypedMap,
  };
});

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: () => <span>later</span>,
}));

jest.mock("@cocalc/frontend/account/codex-credentials-panel", () => ({
  CodexCredentialsPanel: () => null,
  CodexUsageMeters: ({ compact, status, stale, updating }: any) => (
    <div>
      {compact ? "compact usage meters" : "usage meters"}
      {status?.available ? " usage loaded" : ""}
      {stale ? " stale" : ""}
      {updating ? " updating" : ""}
    </div>
  ),
}));

jest.mock("@cocalc/frontend/account/lite-ai-settings", () => () => null);

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        projects: {
          getCodexUsageStatus: (...args: any[]) => getCodexUsageStatus(...args),
        },
        system: {
          getCodexUsageStatus: (...args: any[]) => getCodexUsageStatus(...args),
        },
      },
    },
  },
}));

jest.mock("../use-codex-payment-source", () => ({
  getCodexPaymentSourceShortLabel: (source: string) =>
    source === "site-api-key" ? "Membership" : "ChatGPT",
  getCodexPaymentSourceOptions: (source: any) => [
    {
      value: "auto",
      label: "Automatic",
      description: "Choose automatically",
    },
    ...(source?.hasSubscription
      ? [
          {
            value: "subscription",
            label: "ChatGPT Plan",
            description: "Use ChatGPT",
          },
        ]
      : []),
    ...(source?.hasSiteApiKey
      ? [
          {
            value: "site-api-key",
            label: "CoCalc Membership",
            description: "Use membership allowance",
          },
        ]
      : []),
  ],
  getCodexPaymentSourceTooltip: () => "ChatGPT",
}));

describe("CodexConfigButton", () => {
  beforeEach(() => {
    stableForm.resetFields.mockClear();
    stableForm.setFieldsValue.mockClear();
    stableForm.getFieldsValue.mockClear();
    stableForm.getFieldsValue.mockReturnValue({});
    getCodexUsageStatus.mockReset();
    getCodexUsageStatus.mockResolvedValue({ available: true });
    window.localStorage.clear();
  });

  it("uses the authenticated catalog and preserves only the selected unavailable model", () => {
    const options = codexModelOptionsForCatalog(
      [
        {
          model: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          description: "Fast account model",
          reasoning: [
            {
              id: "extra_high",
              description: "Account-supported deep reasoning",
              default: true,
            },
          ],
          serviceTiers: [
            {
              id: "fast",
              label: "Fast",
              description: "Higher speed",
            },
          ],
          default: true,
        },
        {
          model: "gpt-daybreak-blue-latest",
          displayName: "Daybreak Blue",
          description: "Defensive cybersecurity model",
          specialty: "cybersecurity",
          reasoning: [],
          serviceTiers: [],
        },
      ],
      "gpt-5.4",
    );

    expect(options[0]).toMatchObject({
      value: "gpt-5.6-luna",
      reasoning: [
        {
          id: "extra_high",
          description: "Account-supported deep reasoning",
          default: true,
        },
      ],
      serviceTiers: ["fast"],
    });
    expect(options.find(({ value }) => value === "gpt-5.4")).toMatchObject({
      disabled: true,
      description: expect.stringContaining(
        "Not available with the connected ChatGPT account",
      ),
    });
    const daybreak = options.find(
      ({ value }) => value === "gpt-daybreak-blue-latest",
    );
    expect(daybreak).toMatchObject({
      description: expect.stringContaining("Cybersecurity model"),
    });
    expect(daybreak?.disabled).toBeUndefined();
    expect(options).toHaveLength(3);
  });

  it("opens the compact picker from the fresh account catalog without a request", async () => {
    writeCachedCodexModelCatalog({
      models: [
        {
          model: "gpt-daybreak-blue-latest",
          displayName: "Daybreak Blue",
          description: "Defensive cybersecurity model",
          specialty: "cybersecurity",
          reasoning: [],
          serviceTiers: [],
          default: true,
        },
      ],
    });
    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        projectId="project-1"
        actions={
          {
            getCodexConfig: jest.fn(() => undefined),
            setCodexConfig: jest.fn(),
          } as any
        }
        threadConfig={null}
        paymentSource={{
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: false,
          sharedHomeMode: "disabled",
        }}
      />,
    );

    fireEvent.mouseEnter(screen.getByTitle("Change Codex model"));
    fireEvent.click(screen.getByTitle("Change Codex model"));
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", {
          name: "gpt-daybreak-blue-latest",
        }),
      ).toHaveLength(2);
    });
    expect(getCodexUsageStatus).not.toHaveBeenCalled();
  });

  it("preserves a stored catalog model before discovery runs", async () => {
    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        projectId="project-1"
        actions={
          {
            getCodexConfig: jest.fn(() => undefined),
            setCodexConfig: jest.fn(),
          } as any
        }
        threadConfig={{
          model: "gpt-daybreak-blue-latest",
          paymentSource: "subscription",
        }}
        paymentSource={{
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: false,
          sharedHomeMode: "disabled",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("gpt-daybreak-blue-latest")).toBeTruthy();
    });
    expect(stableForm.setFieldsValue).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-daybreak-blue-latest" }),
    );
    expect(getCodexUsageStatus).not.toHaveBeenCalled();
  });

  it("forces catalog discovery from the settings refresh button", async () => {
    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        projectId="project-1"
        actions={
          {
            getCodexConfig: jest.fn(() => undefined),
            setCodexConfig: jest.fn(),
          } as any
        }
        threadConfig={null}
        paymentSource={{
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: false,
          sharedHomeMode: "disabled",
        }}
      />,
    );

    fireEvent.click(screen.getByText("Codex"));
    await waitFor(() => expect(getCodexUsageStatus).toHaveBeenCalled());
    getCodexUsageStatus.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() => {
      expect(getCodexUsageStatus).toHaveBeenCalledWith({
        project_id: "project-1",
        include_models: true,
        refresh_models: true,
        timeout: 60_000,
      });
    });
  });

  it("marks the configured model unavailable after account discovery", async () => {
    getCodexUsageStatus.mockResolvedValue({
      available: true,
      models: [
        {
          model: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          description: "Fast account model",
          reasoning: [],
          serviceTiers: [],
        },
      ],
    });
    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        projectId="project-1"
        actions={
          {
            getCodexConfig: jest.fn(() => undefined),
            setCodexConfig: jest.fn(),
          } as any
        }
        threadConfig={{ model: "gpt-5.4", paymentSource: "subscription" }}
        paymentSource={{
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: false,
          sharedHomeMode: "disabled",
        }}
      />,
    );

    const modelButton = screen.getByTitle("Change Codex model");
    fireEvent.mouseEnter(modelButton);
    await waitFor(() => {
      expect(getCodexUsageStatus).toHaveBeenCalled();
    });
    fireEvent.click(modelButton);
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("button", { name: "gpt-5.4" })
          .some((button) => (button as HTMLButtonElement).disabled),
      ).toBe(true);
      expect(
        (
          screen.getByRole("button", {
            name: "gpt-5.6-luna",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    await waitFor(() => {
      expect(
        screen.getByText(/Model unavailable for this ChatGPT account/),
      ).toBeTruthy();
    });
  });

  it("reconciles only invalid capability fields when the catalog arrives", async () => {
    let resolveUsageStatus: (status: any) => void = () => undefined;
    getCodexUsageStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveUsageStatus = resolve;
      }),
    );
    stableForm.getFieldsValue.mockReturnValue({
      model: "gpt-5.4",
      reasoning: "extra_high",
      serviceTier: "fast",
      workingDirectory: "keep-my-edit",
    });
    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        projectId="project-1"
        actions={
          {
            getCodexConfig: jest.fn(() => undefined),
            setCodexConfig: jest.fn(),
          } as any
        }
        threadConfig={{
          model: "gpt-5.4",
          reasoning: "extra_high",
          serviceTier: "fast",
          paymentSource: "subscription",
        }}
        paymentSource={{
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: false,
          sharedHomeMode: "disabled",
        }}
      />,
    );

    fireEvent.click(screen.getByText("Codex"));
    await waitFor(() => expect(getCodexUsageStatus).toHaveBeenCalled());
    stableForm.setFieldsValue.mockClear();
    resolveUsageStatus({
      available: true,
      models: [
        {
          model: "gpt-5.4",
          displayName: "GPT-5.4",
          description: "Account model",
          reasoning: [
            {
              id: "low",
              description: "Fast responses",
              default: true,
            },
          ],
          serviceTiers: [],
        },
      ],
    });

    await waitFor(() => {
      expect(stableForm.setFieldsValue).toHaveBeenCalledWith({
        reasoning: "low",
        serviceTier: "standard",
      });
    });
    expect(stableForm.setFieldsValue).not.toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: expect.anything() }),
    );
  });

  it("adopts the discovered default for an untouched new thread", async () => {
    let resolveUsageStatus: (status: any) => void = () => undefined;
    getCodexUsageStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveUsageStatus = resolve;
      }),
    );
    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        projectId="project-1"
        actions={
          {
            getCodexConfig: jest.fn(() => undefined),
            setCodexConfig: jest.fn(),
          } as any
        }
        threadConfig={null}
        paymentSource={{
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: false,
          sharedHomeMode: "disabled",
        }}
      />,
    );

    fireEvent.click(screen.getByText("Codex"));
    await waitFor(() => expect(getCodexUsageStatus).toHaveBeenCalled());
    stableForm.setFieldsValue.mockClear();
    resolveUsageStatus({
      available: true,
      models: [
        {
          model: "account-default-model",
          displayName: "Account default",
          description: "Default for this account",
          reasoning: [],
          serviceTiers: [],
          default: true,
        },
      ],
    });

    await waitFor(() => {
      expect(stableForm.setFieldsValue).toHaveBeenCalledWith(
        expect.objectContaining({ model: "account-default-model" }),
      );
    });
  });

  it("updates the closed top bar when thread config arrives after mount", async () => {
    const actions = {
      getCodexConfig: jest.fn(() => undefined),
      setCodexConfig: jest.fn(),
    } as any;

    const { rerender } = render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={null}
      />,
    );

    expect(screen.queryByTitle("Change Codex access mode")).toBeNull();

    rerender(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={{
          model: "gpt-5.4",
          reasoning: "high",
          sessionMode: "full-access",
          allowWrite: true,
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/gpt-5.4/)).not.toBeNull();
      expect(screen.getByText(/High/)).not.toBeNull();
    });
    expect(screen.queryByText(/Full access/)).toBeNull();
  });

  it("does not overwrite the open dialog when thread config refreshes", async () => {
    const actions = {
      getCodexConfig: jest.fn(() => undefined),
      setCodexConfig: jest.fn(),
    } as any;

    const { rerender } = render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={{
          model: "gpt-5.4",
          reasoning: "medium",
          sessionMode: "workspace-write",
        }}
      />,
    );

    await waitFor(() => {
      expect(stableForm.setFieldsValue).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoning: "medium",
        }),
      );
    });
    const callsBeforeOpen = stableForm.setFieldsValue.mock.calls.length;

    fireEvent.click(screen.getByText("Codex"));

    rerender(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={{
          model: "gpt-5.4",
          reasoning: "high",
          sessionMode: "workspace-write",
        }}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stableForm.setFieldsValue).toHaveBeenCalledTimes(callsBeforeOpen);
    expect(stableForm.setFieldsValue).not.toHaveBeenCalledWith(
      expect.objectContaining({
        reasoning: "high",
      }),
    );
  });

  it("prefills the modal session id from the latest live assistant row", async () => {
    const actions = {
      getCodexConfig: jest.fn(() => undefined),
      getMessagesInThread: jest.fn(() => [
        {
          acp_thread_id: "thr-live-1",
        },
      ]),
      setCodexConfig: jest.fn(),
    } as any;

    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={null}
      />,
    );

    await waitFor(() => {
      expect(stableForm.setFieldsValue).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "thr-live-1",
        }),
      );
    });
  });

  it("does not let an established personal session enter Membership mode", async () => {
    const actions = {
      getCodexConfig: jest.fn(() => undefined),
      setCodexConfig: jest.fn(),
    } as any;

    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={{
          model: "gpt-5.4",
          paymentSource: "subscription",
          sessionId: "thr-established",
        }}
        paymentSource={{
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: true,
          siteAiUsageLimitPositive: true,
          siteFundedCodex: { enabled: true },
          sharedHomeMode: "disabled",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("gpt-5.4")).toBeTruthy();
    });
    fireEvent.click(screen.getByTitle("Change Codex payment source"));
    expect(
      (screen.getByText("CoCalc Membership") as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByText("Codex"));
    expect(document.body.textContent).toContain(
      "Switching an established personal session into membership-funded mode is disabled",
    );
    await waitFor(() => {
      expect(
        screen.getByText("compact usage meters usage loaded"),
      ).toBeTruthy();
    });
    expect(actions.setCodexConfig).not.toHaveBeenCalled();
  });

  it("loads and exposes the connected ChatGPT email when Plan is hovered", async () => {
    getCodexUsageStatus.mockResolvedValue({
      available: true,
      account: {
        account: {
          type: "chatgpt",
          email: "member@example.com",
        },
      },
    });

    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        projectId="project-1"
        actions={
          {
            getCodexConfig: jest.fn(() => undefined),
            setCodexConfig: jest.fn(),
          } as any
        }
        threadConfig={{ paymentSource: "subscription" }}
        paymentSource={{
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: true,
          siteAiUsageLimitPositive: true,
          siteFundedCodex: { enabled: true },
          sharedHomeMode: "disabled",
        }}
      />,
    );

    fireEvent.mouseEnter(screen.getByLabelText("Change Codex payment source"));

    await waitFor(() => {
      expect(getCodexUsageStatus).toHaveBeenCalledWith({
        project_id: "project-1",
        include_models: false,
        refresh_models: false,
        timeout: 60_000,
      });
      expect(
        screen.getByLabelText(
          "Change Codex payment source. Connected ChatGPT account: member@example.com",
        ),
      ).toBeTruthy();
    });
  });

  it("upgrades a Membership session to ChatGPT without losing its context", async () => {
    const actions = {
      getCodexConfig: jest.fn(() => undefined),
      setCodexConfig: jest.fn(),
    } as any;

    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={{
          model: "gpt-5.6-sol",
          paymentSource: "site-api-key",
          sessionId: "thr-established",
        }}
        paymentSource={
          {
            source: "site-api-key",
            hasSubscription: true,
            hasProjectApiKey: false,
            hasAccountApiKey: false,
            hasSiteApiKey: true,
            siteAiUsageLimitPositive: true,
            siteFundedCodex: {
              enabled: true,
              policy: {
                model: "gpt-5.6-luna",
                reasoning: "low",
                serviceTier: "standard",
              },
              status: {
                pools: [],
                account: {
                  accountId: "account-1",
                  committed5hMicrousd: 50_000,
                  committed7dMicrousd: 100_000,
                  activeReservedMicrousd: 0,
                  limit5hMicrousd: 200_000,
                  limit7dMicrousd: 500_000,
                  remaining5hMicrousd: 150_000,
                  remaining7dMicrousd: 400_000,
                  reset5hAt: "2026-08-04T04:00:00.000Z",
                  reset7dAt: "2026-08-10T23:00:00.000Z",
                },
              },
            },
            sharedHomeMode: "disabled",
          } as any
        }
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("gpt-5.6-luna")).toBeTruthy();
    });
    expect(screen.queryByText("Standard")).toBeNull();
    fireEvent.click(screen.getByTitle("Change Codex payment source"));
    fireEvent.click(screen.getByText("ChatGPT Plan"));

    expect(actions.setCodexConfig).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        model: "gpt-5.6-luna",
        paymentSource: "subscription",
        reasoning: "low",
        serviceTier: "standard",
        sessionId: "thr-established",
      }),
    );

    fireEvent.click(screen.getByText("Codex"));
    expect(screen.getByLabelText("5-hour limit: 75% remaining")).toBeTruthy();
    expect(screen.getByLabelText("7-day limit: 80% remaining")).toBeTruthy();
  });

  it("uses a stable thread config key independent of object identity", () => {
    expect(
      codexThreadConfigKey({
        model: "gpt-5.4",
        reasoning: "medium",
        sessionMode: "workspace-write",
      }),
    ).toBe(
      codexThreadConfigKey({
        sessionMode: "workspace-write",
        reasoning: "medium",
        model: "gpt-5.4",
      }),
    );
    expect(
      codexThreadConfigKey({
        model: "gpt-5.4",
        reasoning: "medium",
        sessionMode: "workspace-write",
      }),
    ).not.toBe(
      codexThreadConfigKey({
        model: "gpt-5.4",
        reasoning: "high",
        sessionMode: "workspace-write",
      }),
    );
  });

  it("hides cloud access mode controls and explains full access", async () => {
    const actions = {
      getCodexConfig: jest.fn(() => undefined),
      setCodexConfig: jest.fn(),
    } as any;

    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={{
          model: "gpt-5.4",
          reasoning: "medium",
          sessionMode: "workspace-write",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("gpt-5.4")).not.toBeNull();
    });

    expect(screen.queryByTitle("Change Codex access mode")).toBeNull();
    expect(screen.queryByText("Workspace write")).toBeNull();
    expect(screen.queryByText("Read only")).toBeNull();

    fireEvent.click(screen.getByText("Codex"));
    expect(document.body.textContent).toContain(
      "Codex has full access to this project",
    );
    expect(screen.queryByText("Read only")).toBeNull();
    expect(actions.setCodexConfig).not.toHaveBeenCalled();
  });

  it("uses separate compact-mode targets for settings and expanding controls", async () => {
    window.localStorage.setItem("cocalc.chat.codexControlsCollapsed", "1");

    const actions = {
      getCodexConfig: jest.fn(() => undefined),
      setCodexConfig: jest.fn(),
    } as any;

    const { unmount } = render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={{
          model: "gpt-5.4",
          reasoning: "medium",
          sessionMode: "workspace-write",
        }}
      />,
    );

    fireEvent.click(screen.getByText("Codex"));
    expect(screen.getByText("Codex configuration for this chat")).toBeTruthy();
    unmount();
    window.localStorage.setItem("cocalc.chat.codexControlsCollapsed", "1");

    render(
      <CodexConfigButton
        threadKey="thread-2"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={{
          model: "gpt-5.4",
          reasoning: "medium",
          sessionMode: "workspace-write",
        }}
      />,
    );

    fireEvent.click(screen.getByLabelText("Expand Codex controls"));

    await waitFor(() => {
      expect(screen.getByText("gpt-5.4")).toBeTruthy();
    });
    expect(screen.queryByTitle("Change Codex access mode")).toBeNull();
  });

  it("collapses expanded controls from the in-pill chevron without opening settings", async () => {
    const actions = {
      getCodexConfig: jest.fn(() => undefined),
      setCodexConfig: jest.fn(),
    } as any;

    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={actions}
        threadConfig={{
          model: "gpt-5.4",
          reasoning: "medium",
          sessionMode: "workspace-write",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("gpt-5.4")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Hide Codex controls"));

    expect(screen.queryByText("Codex configuration for this chat")).toBeNull();
    expect(screen.getByLabelText("Expand Codex controls")).toBeTruthy();
  });

  it("shows the ChatGPT Codex usage link in payment settings", async () => {
    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        actions={
          {
            getCodexConfig: jest.fn(() => undefined),
            setCodexConfig: jest.fn(),
          } as any
        }
        threadConfig={null}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("ChatGPT")).not.toBeNull();
    });
    fireEvent.click(screen.getByText("ChatGPT"));

    expect(screen.getByText("Open ChatGPT Codex Usage")).not.toBeNull();
  });

  it("shows compact ChatGPT usage in the settings summary", async () => {
    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        projectId="project-1"
        actions={
          {
            getCodexConfig: jest.fn(() => undefined),
            setCodexConfig: jest.fn(),
          } as any
        }
        threadConfig={null}
        paymentSource={{
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: false,
          sharedHomeMode: "disabled",
        }}
      />,
    );

    fireEvent.click(screen.getByText("Codex"));

    await waitFor(() => {
      expect(getCodexUsageStatus).toHaveBeenCalledWith({
        project_id: "project-1",
        include_models: true,
        refresh_models: false,
        timeout: 60_000,
      });
      expect(
        screen.getByText("compact usage meters usage loaded"),
      ).toBeTruthy();
    });
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Codex configuration for this chat")).toBeLessThan(
      text.indexOf("compact usage meters usage loaded"),
    );
    expect(text.indexOf("compact usage meters usage loaded")).toBeLessThan(
      text.indexOf("Payment & Credentials"),
    );
  });

  it("shows cached compact ChatGPT usage while refreshing live usage", async () => {
    let resolveLiveUsage: (status: unknown) => void = () => {};
    const liveUsagePromise = new Promise((resolve) => {
      resolveLiveUsage = resolve;
    });
    getCodexUsageStatus.mockReturnValue(liveUsagePromise);
    writeCachedCodexUsageStatus({
      status: {
        available: true,
        checkedAt: "2026-06-20T00:00:00.000Z",
        paymentSource: {
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: false,
          sharedHomeMode: "disabled",
        },
        rateLimits: {
          rateLimits: {
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
            },
          },
        },
      } as any,
    });

    render(
      <CodexConfigButton
        threadKey="thread-1"
        chatPath="foo.chat"
        projectId="project-1"
        actions={
          {
            getCodexConfig: jest.fn(() => undefined),
            setCodexConfig: jest.fn(),
          } as any
        }
        threadConfig={null}
        paymentSource={{
          source: "subscription",
          hasSubscription: true,
          hasProjectApiKey: false,
          hasAccountApiKey: false,
          hasSiteApiKey: false,
          sharedHomeMode: "disabled",
        }}
      />,
    );

    fireEvent.click(screen.getByText("Codex"));

    await waitFor(() => {
      expect(
        screen.getByText("compact usage meters usage loaded stale updating"),
      ).toBeTruthy();
    });

    resolveLiveUsage({ available: true, fresh: true });

    await waitFor(() => {
      expect(
        screen.getByText("compact usage meters usage loaded"),
      ).toBeTruthy();
    });
  });
});
