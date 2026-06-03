/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodexConfigButton, codexThreadConfigKey } from "../codex";

const stableForm = {
  resetFields: jest.fn(),
  setFieldsValue: jest.fn(),
  getFieldsValue: jest.fn(() => ({})),
};

jest.mock("antd", () => {
  const Radio = ({ children }: any) => <label>{children}</label>;
  Radio.Group = ({ children }: any) => <div>{children}</div>;
  return {
    __esModule: true,
    Alert: ({ children }: any) => <div>{children}</div>,
    Button: ({ children, onClick }: any) => (
      <button onClick={onClick}>{children}</button>
    ),
    Divider: () => <div />,
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
}));

jest.mock("@cocalc/frontend/account/lite-ai-settings", () => () => null);

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: {},
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

  it("shows a codex usage link in the payment modal", () => {
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

    fireEvent.click(screen.getByText("ChatGPT"));

    const usageLink = screen.getByRole("link", {
      name: /codex usage in chatgpt/i,
    });
    expect(usageLink.getAttribute("href")).toBe(
      "https://chatgpt.com/codex/settings/usage",
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
});
