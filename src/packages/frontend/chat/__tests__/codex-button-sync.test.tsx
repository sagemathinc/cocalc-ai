/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodexConfigButton } from "../codex";

const stableForm = {
  resetFields: jest.fn(),
  setFieldsValue: jest.fn(),
  getFieldsValue: jest.fn(() => ({})),
};

jest.mock("antd", () => {
  return {
    __esModule: true,
    Alert: ({ children }: any) => <div>{children}</div>,
    Button: ({ children, onClick }: any) => (
      <button onClick={onClick}>{children}</button>
    ),
    Divider: () => <div />,
    Input: () => <input />,
    Modal: ({ open, children }: any) => (open ? <div>{children}</div> : null),
    Radio: {
      Group: ({ children }: any) => <div>{children}</div>,
    },
    Select: ({ value }: any) => <div>{String(value ?? "")}</div>,
    Space: ({ children }: any) => <div>{children}</div>,
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

    expect(screen.getByText("workspace-write")).not.toBeNull();

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
      expect(screen.getByText("gpt-5.4")).not.toBeNull();
      expect(screen.getByText("full-access")).not.toBeNull();
      expect(screen.getByText("high")).not.toBeNull();
    });
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
});
