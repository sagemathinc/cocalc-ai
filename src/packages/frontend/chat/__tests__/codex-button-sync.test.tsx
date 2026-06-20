/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodexConfigButton, codexThreadConfigKey } from "../codex";

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
    Alert: ({ children }: any) => <div>{children}</div>,
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

jest.mock("@cocalc/frontend/account/codex-credentials-panel", () => ({
  CodexCredentialsPanel: () => null,
  CodexUsageMeters: ({ compact, status }: any) => (
    <div>
      {compact ? "compact usage meters" : "usage meters"}
      {status?.available ? " usage loaded" : ""}
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
  getCodexPaymentSourceShortLabel: () => "ChatGPT",
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
    window.localStorage.removeItem("cocalc.chat.codexControlsCollapsed");
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

    expect(screen.getByText(/Workspace write/)).not.toBeNull();

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
      expect(screen.getByText(/Full access/)).not.toBeNull();
      expect(screen.getByText(/High/)).not.toBeNull();
    });
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

  it("changes access mode from the compact pill without opening settings", async () => {
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
      expect(screen.getByText("Workspace write")).not.toBeNull();
    });

    fireEvent.click(screen.getByTitle("Change Codex access mode"));
    expect(screen.queryByText("Codex configuration for this chat")).toBeNull();
    fireEvent.click(screen.getByText("Read only"));

    expect(actions.setCodexConfig).toHaveBeenCalledWith(
      "thread-1",
      expect.objectContaining({
        allowWrite: false,
        model: "gpt-5.4",
        reasoning: "medium",
        sessionMode: "read-only",
      }),
    );
    expect(screen.queryByText("Codex configuration for this chat")).toBeNull();
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
      expect(screen.getByText("Workspace write")).toBeTruthy();
    });
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
});
