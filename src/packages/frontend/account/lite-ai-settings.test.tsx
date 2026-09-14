/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import LiteAISettings from "./lite-ai-settings";

const queryMock = jest.fn();
const setSiteSettingsMock = jest.fn();
const postAuthApiMock = jest.fn();
const clearOpenAICacheMock = jest.fn();
const reloadCustomizeMock = jest.fn();

jest.mock("antd", () => {
  const Input = {
    Password: ({ "aria-label": ariaLabel, id, onChange, value }: any) => (
      <input
        aria-label={ariaLabel}
        id={id}
        type="password"
        value={value}
        onChange={onChange}
      />
    ),
  };
  return {
    Alert: ({ description, title }: any) => (
      <div role="alert">
        {title}
        {description}
      </div>
    ),
    Button: ({ children, disabled, onClick }: any) => (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
    Input,
    Modal: ({ children, okButtonProps, okText, onCancel, onOk, open }: any) =>
      open ? (
        <div role="dialog" aria-label="Authorize site setting change">
          {children}
          <button
            type="button"
            disabled={okButtonProps?.disabled}
            onClick={onOk}
          >
            {okText}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : null,
    Space: ({ children }: any) => <div>{children}</div>,
    Typography: {
      Paragraph: ({ children }: any) => <p>{children}</p>,
      Title: ({ children }: any) => <h2>{children}</h2>,
    },
  };
});

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({ reload: reloadCustomizeMock }),
    getStore: () => ({ clearOpenAICache: clearOpenAICacheMock }),
  },
}));

jest.mock("@cocalc/frontend/auth/api", () => ({
  postAuthApi: (...args: any[]) => postAuthApiMock(...args),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Gap: () => null,
  Loading: ({ text }: any) => <span>{text}</span>,
}));

jest.mock("@cocalc/frontend/frame-editors/generic/client", () => ({
  query: (...args: any[]) => queryMock(...args),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        system: {
          setSiteSettings: (...args: any[]) => setSiteSettingsMock(...args),
        },
      },
    },
  },
}));

describe("LiteAISettings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryMock.mockResolvedValue({ query: { site_settings: [] } });
    postAuthApiMock.mockResolvedValue({ fresh_auth_token: "fresh-token" });
    setSiteSettingsMock.mockResolvedValue({
      local_bay_id: "bay-0",
      count: 1,
      bays: [{ bay_id: "bay-0", status: "local" }],
    });
  });

  it("proves the Lite access token before using the domain API", async () => {
    render(<LiteAISettings />);

    const input = await screen.findByLabelText("OpenAI API Key");
    fireEvent.change(input, { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByRole("dialog", { name: "Authorize site setting change" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("CoCalc Lite access token"), {
      target: { value: "lite-access-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Authorize and save" }));

    await waitFor(() => {
      expect(postAuthApiMock).toHaveBeenCalledWith({
        endpoint: "auth/lite-site-settings-authorize",
        body: {
          access_token: "lite-access-token",
          browser_id: "browser-1",
        },
      });
      expect(setSiteSettingsMock).toHaveBeenCalledWith({
        settings: [{ name: "openai_api_key", value: "sk-test" }],
        browser_id: "browser-1",
        fresh_auth_token: "fresh-token",
      });
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(clearOpenAICacheMock).toHaveBeenCalledTimes(1);
    expect(reloadCustomizeMock).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("dialog", { name: "Authorize site setting change" }),
    ).toBeNull();
  });
});
