/** @jest-environment jsdom */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Map as ImmutableMap } from "immutable";
import { forwardRef, useImperativeHandle, useRef } from "react";

import NewFilePage from "./new-file-page";

const mockCreateFolder = jest.fn();
const mockCreateFile = jest.fn();
const mockSetActiveTab = jest.fn();
const mockSetCurrentPath = jest.fn();
const mockSetNewFilenameFamily = jest.fn();
const mockSetState = jest.fn();
const mockSetOtherSettings = jest.fn();

jest.mock("antd", () => {
  const React = require("react");
  const Button = ({ children, icon, onClick, disabled, ...props }: any) => (
    <button type="button" onClick={onClick} disabled={disabled} {...props}>
      {icon}
      {children}
    </button>
  );
  const Input = React.forwardRef(
    (
      { value, onChange, onPressEnter, placeholder, disabled, ...props }: any,
      ref: any,
    ) => {
      const inputRef = React.useRef<HTMLInputElement>(null);
      React.useImperativeHandle(ref, () => ({
        input: inputRef.current,
        focus: () => inputRef.current?.focus(),
        select: () => inputRef.current?.select(),
      }));
      return (
        <input
          ref={inputRef}
          value={value}
          onChange={onChange}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onPressEnter?.(event);
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          {...props}
        />
      );
    },
  );
  const Modal = ({
    children,
    open,
    onOk,
    okText = "OK",
    okButtonProps,
    title,
  }: any) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
        <button type="button" disabled={okButtonProps?.disabled} onClick={onOk}>
          {okText}
        </button>
      </div>
    ) : null;
  const Select = () => <select aria-label="Search file types" />;
  const Space = ({ children }: any) => <div>{children}</div>;
  return { Button, Input, Modal, Select, Space };
});

jest.mock("@cocalc/frontend/account", () => ({
  default_filename: () => "default.txt",
}));

jest.mock("@cocalc/frontend/antd-bootstrap", () => ({
  Alert: ({ children }: any) => <div>{children}</div>,
  Col: ({ children }: any) => <div>{children}</div>,
  Row: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: (name: string) =>
      name === "account" ? { set_other_settings: mockSetOtherSettings } : {},
    getStore: () => ({ getIn: () => undefined }),
  },
  useActions: () => ({
    createFile: mockCreateFile,
    createFolder: mockCreateFolder,
    set_active_tab: mockSetActiveTab,
    set_current_path: mockSetCurrentPath,
    set_new_filename_family: mockSetNewFilenameFamily,
    setState: mockSetState,
  }),
  useTypedRedux: (store: any, key: string) => {
    if (store === "account" && key === "other_settings") return ImmutableMap();
    if (key === "current_path_abs") return "/work";
    if (key === "default_filename") return "draft.md";
    if (key === "file_creation_error") return "";
    return undefined;
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  ErrorDisplay: ({ error }: any) => <div>{error}</div>,
  Icon: ({ name }: any) => <span data-icon={name} />,
  Loading: () => <span>Loading</span>,
  Paragraph: ({ children }: any) => <p>{children}</p>,
  SelectorInput: ({ on_change, selected }: any) => (
    <button type="button" onClick={() => on_change("pet")}>
      Filename generator: {selected}
    </button>
  ),
  SettingBox: ({ children, title, subtitle }: any) => (
    <section>
      <header>{title}</header>
      <div>{subtitle}</div>
      {children}
    </section>
  ),
  Tip: ({ children }: any) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/file-associations", () => ({
  filenameIcon: () => "file",
  file_associations: {
    md: { name: "Markdown", ext: "md" },
  },
}));

jest.mock("@cocalc/frontend/file-upload", () => ({
  FileUpload: () => <div>File upload</div>,
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    cancel: { defaultMessage: "Cancel" },
    download: { defaultMessage: "download" },
    folder: { defaultMessage: "folder" },
  },
}));

jest.mock("@cocalc/frontend/project-file", () => ({
  special_filenames_with_no_extension: () => [],
}));

jest.mock("@cocalc/frontend/project/page/activity-bar", () => ({
  getValidActivityBarOption: () => "tabs",
}));

jest.mock("@cocalc/frontend/project/page/activity-bar-consts", () => ({
  ACTIVITY_BAR_KEY: "activity-bar",
}));

jest.mock("@cocalc/frontend/project/utils", () => ({
  NewFilenameFamilies: {
    iso: "Current time",
    pet: "Pet names",
  },
}));

jest.mock("../explorer/path-navigator", () => ({
  PathNavigator: () => <span>Home</span>,
}));

jest.mock("../use-available-features", () => ({
  useAvailableFeatures: () => ({
    jupyter_notebook: true,
    latex: true,
    qmd: true,
    rmd: true,
    sage: true,
  }),
}));

jest.mock("./new-file-button", () => ({
  NewFileButton: ({ name, on_click, ext }: any) => (
    <button type="button" onClick={() => on_click(ext)}>
      {name}
    </button>
  ),
}));

jest.mock("./launcher-catalog", () => ({
  QUICK_CREATE_MAP: {},
}));

jest.mock("./launcher-preferences", () => ({
  LAUNCHER_SETTINGS_KEY: "launcher-settings",
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY: "launcher-defaults",
  getAccountLauncherPrefs: () => ({}),
  getEffectiveLauncher: () => ({ quickCreate: [] }),
  getSiteLauncherDefaults: () => ({}),
  updateAccountLauncherPrefs: () => ({}),
}));

jest.mock("./launcher-customize-modal", () => ({
  LauncherCustomizeModal: () => null,
}));

jest.mock("@cocalc/frontend/editor-tmp", () => ({
  file_options: () => ({ icon: "file", name: "File" }),
}));

jest.mock("react-intl", () => ({
  defineMessage: (msg: any) => msg,
  FormattedMessage: ({ defaultMessage }: any) => <>{defaultMessage}</>,
  useIntl: () => ({
    formatMessage: (message: any, values?: any) => {
      const text = message?.defaultMessage ?? message?.id ?? "";
      return values?.desc ? text.replace("{desc}", values.desc) : text;
    },
  }),
}));

describe("NewFilePage folder creation", () => {
  beforeEach(() => {
    mockCreateFolder.mockReset();
    mockCreateFolder.mockResolvedValue(undefined);
    mockCreateFile.mockReset();
    mockSetActiveTab.mockReset();
    mockSetCurrentPath.mockReset();
    mockSetNewFilenameFamily.mockReset();
    mockSetState.mockReset();
    mockSetOtherSettings.mockReset();
  });

  it("opens a selected folder-name modal from the top folder button", async () => {
    render(<NewFilePage project_id="project-1" />);

    expect(
      screen.queryByRole("button", { name: /Create folder/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Folder/i }));

    const dialog = screen.getByRole("dialog", { name: "Create folder" });
    const input = within(dialog).getByDisplayValue(
      "draft.md",
    ) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("draft.md".length);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mockCreateFolder).toHaveBeenCalledWith({
        name: "draft.md",
        current_path: "/work",
        switch_over: true,
      }),
    );
  });

  it("shows the filename generator selector", () => {
    render(<NewFilePage project_id="project-1" />);

    fireEvent.click(screen.getByText(/Filename generator:/));

    expect(mockSetNewFilenameFamily).toHaveBeenCalledWith("pet");
  });
});
