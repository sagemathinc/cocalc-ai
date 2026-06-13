/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Input, Modal, Select, Space } from "antd";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defineMessage, FormattedMessage, useIntl } from "react-intl";
import { default_filename } from "@cocalc/frontend/account";
import { Alert, Col, Row } from "@cocalc/frontend/antd-bootstrap";
import {
  ProjectActions,
  redux,
  useAccountOtherSetting,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  ErrorDisplay,
  Icon,
  Loading,
  Paragraph,
  SelectorInput,
  SettingBox,
  Tip,
} from "@cocalc/frontend/components";
import {
  filenameIcon,
  file_associations,
} from "@cocalc/frontend/file-associations";
import type { IconName } from "@cocalc/frontend/components/icon";
import { FileUpload } from "@cocalc/frontend/file-upload";
import { labels } from "@cocalc/frontend/i18n";
import { special_filenames_with_no_extension } from "@cocalc/frontend/project-file";
import { getValidActivityBarOption } from "@cocalc/frontend/project/page/activity-bar";
import { ACTIVITY_BAR_KEY } from "@cocalc/frontend/project/page/activity-bar-consts";
import { NewFilenameFamilies } from "@cocalc/frontend/project/utils";
import {
  capitalize,
  filename_extension,
  is_only_downloadable,
  keys,
} from "@cocalc/util/misc";
import { DEFAULT_NEW_FILENAMES, NEW_FILENAMES } from "@cocalc/util/db-schema";
import type { NewFilenameTypes } from "@cocalc/util/db-schema/defaults";
import { FindScopeBar } from "../find/find-scope-bar";
import type { FindScopeMode } from "../find/types";
import { getProjectHomeDirectory } from "../home-directory";
import { useAvailableFeatures } from "../use-available-features";
import { NewFileButton } from "./new-file-button";
import { getQuickCreateSpec, isQuickCreateAvailable } from "./launcher-catalog";
import { file_options } from "@cocalc/frontend/editor-tmp";
import {
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  LAUNCHER_SETTINGS_KEY,
  getAccountLauncherPrefs,
  getEffectiveLauncher,
  getSiteLauncherDefaults,
  updateAccountLauncherPrefs,
} from "./launcher-preferences";
import { LauncherCustomizeModal } from "./launcher-customize-modal";
import { QuickCreateDropdown } from "./quick-create-dropdown";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";

const CREATE_MSG = defineMessage({
  id: "project.new.new-file-page.create.title",
  defaultMessage: `Create {desc}`,
  description: "creating a file with the given description in a file-system",
});

interface Props {
  project_id: string;
  initialFilename?: string;
  autoFocusFilename?: boolean;
  mode?: "page" | "flyout";
  isVisible?: boolean;
}

export default function NewFilePage(props: Props) {
  function launcherLabel(value?: string): string {
    return capitalize(value ?? "");
  }

  const intl = useIntl();
  const {
    project_id,
    initialFilename,
    autoFocusFilename = true,
    mode = "page",
    isVisible = true,
  } = props;
  const inputRef = useRef<any>(null);
  const folderInputRef = useRef<any>(null);
  useEffect(() => {
    if (!autoFocusFilename || !isVisible) return;
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, 1);
  }, [autoFocusFilename, isVisible]);
  const actions = useActions({ project_id });
  const availableFeatures = useAvailableFeatures(project_id);
  const selectedFilenameFamily =
    useAccountOtherSetting<NewFilenameTypes>(NEW_FILENAMES) ??
    DEFAULT_NEW_FILENAMES;
  const launcherSettings = useAccountOtherSetting(LAUNCHER_SETTINGS_KEY);
  const site_launcher_quick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  );
  const [extensionWarning, setExtensionWarning] = useState<boolean>(false);
  const current_path_abs = useTypedRedux({ project_id }, "current_path_abs");
  const effective_current_path = current_path_abs ?? "/";
  const filename0 = useTypedRedux({ project_id }, "default_filename");
  function makeDefaultFilename(ext?: string): string {
    return default_filename(ext, project_id);
  }
  const fallbackFilename = useMemo(
    () => (filename0 ? filename0 : default_filename(undefined, project_id)),
    [filename0, isVisible, project_id],
  );
  const [filename, setFilename] = useState<string>(
    initialFilename?.trim() ? initialFilename : fallbackFilename,
  );
  const [filenameChanged, setFilenameChanged] = useState<boolean>(
    !!initialFilename?.trim(),
  );
  useEffect(() => {
    if (initialFilename === undefined) return;
    const hasInitialFilename = !!initialFilename.trim();
    setFilename(hasInitialFilename ? initialFilename : fallbackFilename);
    setFilenameChanged(hasInitialFilename);
  }, [initialFilename, fallbackFilename]);
  useEffect(() => {
    if (!isVisible || filenameChanged || initialFilename?.trim()) return;
    setFilename(fallbackFilename);
    setExtensionWarning(false);
  }, [fallbackFilename, filenameChanged, initialFilename, isVisible]);
  const [showCustomizeModal, setShowCustomizeModal] = useState<boolean>(false);
  const [showUploadModal, setShowUploadModal] = useState<boolean>(false);
  const [showFolderModal, setShowFolderModal] = useState<boolean>(false);
  const [scopeMode, setScopeMode] = useState<FindScopeMode>("current");
  const [folderName, setFolderName] = useState<string>("");
  const [creatingFolder, setCreatingFolder] = useState<boolean>(false);
  const file_creation_error = useTypedRedux(
    { project_id },
    "file_creation_error",
  );

  const siteLauncherDefaults = getSiteLauncherDefaults(site_launcher_quick);
  const homePath = useMemo(
    () => getProjectHomeDirectory(project_id),
    [project_id],
  );
  const accountLauncherPrefs = getAccountLauncherPrefs(launcherSettings);
  const mergedLauncher = getEffectiveLauncher({
    accountPrefs: accountLauncherPrefs,
    siteDefaults: siteLauncherDefaults,
  });

  const quickCreateIds = mergedLauncher.quickCreate
    .filter((id) => id !== "sage")
    .filter((id) => isQuickCreateAvailable(id, availableFeatures));
  const quickCreateSpecs = quickCreateIds.map(getQuickCreateSpec);

  const moreFileTypeOptions = useMemo(() => {
    const list = keys(file_associations).sort();
    const seen = new Set<string>();
    const options: { value: string; label: ReactNode }[] = [];
    for (let ext of list) {
      if (ext === "/" || ext === "sage") continue;
      const data = file_associations[ext];
      if (data?.exclude_from_menu) continue;
      if (data?.name && seen.has(data.name)) continue;
      if (data?.name) seen.add(data.name);
      const value = data?.ext ?? ext;
      if (!value || value === "sage") continue;
      const info = file_options(`x.${value}`);
      const icon = (info.icon ?? "file") as IconName;
      options.push({
        value,
        label: (
          <span>
            <Icon name={icon} /> {launcherLabel(info.name ?? value)}{" "}
            <span style={{ opacity: 0.6 }}>({value})</span>
          </span>
        ),
      });
    }
    return options;
  }, []);

  function getActions(): ProjectActions {
    if (actions == null) throw new Error("bug");
    return actions;
  }

  function saveUserLauncherPrefs(prefs: any | null) {
    const next = updateAccountLauncherPrefs(launcherSettings, prefs);
    redux.getActions("account").set_other_settings(LAUNCHER_SETTINGS_KEY, next);
  }

  function setNewFilenameFamily(family: string) {
    getActions().set_new_filename_family(family);
  }

  const [creatingFile, setCreatingFile] = useState<string>("");

  useEffect(() => {
    if (!showFolderModal) return;
    setTimeout(() => {
      const input = folderInputRef.current?.input ?? folderInputRef.current;
      input?.focus?.();
      input?.select?.();
    }, 1);
  }, [showFolderModal]);

  if (actions == null) {
    return <Loading theme="medium" />;
  }

  async function createFile(ext?: string, overrideFilename?: string) {
    const filename = overrideFilename ?? inputRef.current?.input.value;
    if (!filename) {
      return;
    }
    const filename_ext = filename_extension(filename);
    const name =
      filename_ext && ext && filename_ext != ext
        ? filename.slice(0, filename.length - filename_ext.length - 1)
        : filename;
    try {
      setCreatingFile(name + (ext ? "." + ext : ""));
      await getActions().createFile({
        name,
        ext,
        current_path: effective_current_path,
      });
      resetToGeneratedFilename(ext ?? filename_extension(filename));
    } finally {
      setCreatingFile("");
    }
  }

  function resetToGeneratedFilename(ext?: string) {
    const next = makeDefaultFilename(ext);
    getActions().set_next_default_filename(next);
    setFilename(next);
    setFilenameChanged(false);
    setExtensionWarning(false);
  }

  function submit(ext?: string) {
    const filename = inputRef.current?.input.value;
    if (!filename) {
      // empty filename
      return;
    }
    if (ext || special_filenames_with_no_extension().indexOf(filename) > -1) {
      createFile(ext);
    } else if (filename[filename.length - 1] === "/") {
      createFolder();
    } else if (filename_extension(filename) || is_only_downloadable(filename)) {
      createFile();
    } else {
      setExtensionWarning(true);
    }
  }

  function quickCreate(ext: string) {
    const current = inputRef.current?.input.value?.trim();
    if (!current) {
      const next = filename0 ? filename0 : default_filename(ext, project_id);
      setFilename(next);
      createFile(ext, next);
      return;
    }
    submit(ext);
  }

  function renderError() {
    let message;
    const error = file_creation_error;
    if (error === "not running") {
      message = "The project is not running. Please try again in a moment";
    } else {
      message = error;
    }
    return (
      <ErrorDisplay
        error={message}
        onClose={(): void => {
          getActions().setState({ file_creation_error: "" });
        }}
      />
    );
  }

  async function createFolder(name = filename) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      setCreatingFolder(true);
      await getActions().createFolder({
        name: trimmed,
        current_path: effective_current_path,
        switch_over: true,
      });
      setShowFolderModal(false);
    } finally {
      setCreatingFolder(false);
    }
  }

  function openFolderModal() {
    setFolderName(inputRef.current?.input?.value ?? filename);
    setShowFolderModal(true);
  }

  function renderNoExtensionAlert() {
    return (
      <Alert
        bsStyle="warning"
        style={{ marginTop: "10px", marginBottom: "10px", fontWeight: "bold" }}
      >
        <Paragraph>
          Warning: Are you sure you want to create a file with no extension?
          This will use a plain text editor. If you do not want this, click a
          button below to create the corresponding type of file.
        </Paragraph>
        <Space>
          <Button
            onClick={(): void => {
              createFile();
            }}
            type="primary"
          >
            Yes, please create this file with no extension
          </Button>
          <Button
            onClick={(): void => {
              setExtensionWarning(false);
            }}
          >
            {intl.formatMessage(labels.cancel)}
          </Button>
        </Space>
      </Alert>
    );
  }

  const renderCreate = () => {
    let desc: string;
    const ext = filename_extension(filename);
    const isFolder = filename.endsWith("/");
    const isUrl =
      filename.toLowerCase().startsWith("http:") ||
      filename.toLowerCase().startsWith("https:");
    if (!ext && !isFolder && !isUrl) {
      return null;
    }
    if (filename.endsWith("/")) {
      desc = intl.formatMessage(labels.folder);
    } else if (isUrl) {
      desc = intl.formatMessage(labels.download);
    } else {
      if (ext) {
        desc = intl.formatMessage(
          {
            id: "project.new.new-file-page.create.desc_file",
            defaultMessage: "{ext} file",
            description: "An extension-named file on a button",
          },
          { ext },
        );
      } else {
        desc = intl.formatMessage({
          id: "project.new.new-file-page.create.desc_file_generic",
          defaultMessage: "File",
          description: "A generic file create label",
        });
      }
    }
    const title = intl.formatMessage(CREATE_MSG, { desc });

    return (
      <Tip
        icon="file"
        title={title}
        tip={intl.formatMessage(
          {
            id: "project.new.new-file-page.create.tooltip",
            defaultMessage: `{title}.  You can also press return.`,
            description:
              "Informing the user in this tooltip, that it is also possible to press the return key",
          },
          { title },
        )}
      >
        <Button
          size="large"
          disabled={filename.trim() == ""}
          onClick={() => submit()}
          block={mode === "flyout" ? true : undefined}
          style={{
            minWidth: mode === "flyout" ? 0 : undefined,
            whiteSpace: mode === "flyout" ? "normal" : undefined,
            height: mode === "flyout" ? "auto" : undefined,
            textAlign: mode === "flyout" ? "center" : undefined,
          }}
        >
          <Icon name={filenameIcon(filename)} />{" "}
          {intl.formatMessage(CREATE_MSG, { desc })}
        </Button>
      </Tip>
    );
  };

  function closeNewPage() {
    // Showing homepage in flyout only mode, otherwise the files as usual
    const account_store = redux.getStore("account") as any;
    const actBar = account_store?.getIn(["other_settings", ACTIVITY_BAR_KEY]);
    const pureFlyoutMode = getValidActivityBarOption(actBar) === "flyout";
    actions?.set_active_tab(pureFlyoutMode ? "home" : "files");
  }

  function renderActionButtons() {
    return (
      <Space size={6} wrap>
        <Button size="small" onClick={() => setShowUploadModal(true)}>
          <Icon name="cloud-upload" /> Upload
        </Button>
        <Button size="small" onClick={openFolderModal}>
          <Icon name="folder" /> Folder
        </Button>
      </Space>
    );
  }

  function changeCurrentPath(path: string) {
    actions?.set_current_path(normalizeAbsolutePath(path || "/", homePath));
    actions?.set_active_tab("new");
  }

  function renderCreateScopeBar() {
    return (
      <FindScopeBar
        mode={mode === "flyout" ? "flyout" : "project"}
        project_id={project_id}
        homePath={homePath}
        currentPath={effective_current_path}
        scopePath={effective_current_path}
        scopeMode={scopeMode}
        scopePinned={false}
        history={[]}
        label="Create in"
        selectorTitle="Select Folder"
        selectorOkText="Use this folder"
        onScopeModeChange={setScopeMode}
        onScopePathChange={changeCurrentPath}
        onScopePinnedChange={() => undefined}
      />
    );
  }

  function renderFlyoutTopControls() {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          marginBottom: 14,
        }}
      >
        {renderCreateScopeBar()}
        <Space size={6} wrap>
          <QuickCreateDropdown
            quickCreateIds={mergedLauncher.quickCreate}
            availableFeatures={availableFeatures}
            onCreateFile={quickCreate}
            onCreateFolder={openFolderModal}
            onCustomize={() => setShowCustomizeModal(true)}
            size="small"
          />
          <Button size="small" onClick={() => setShowUploadModal(true)}>
            <Icon name="cloud-upload" /> Upload
          </Button>
          <Button size="small" onClick={openFolderModal}>
            <Icon name="folder" /> Folder
          </Button>
        </Space>
      </div>
    );
  }

  //key is so autofocus works below
  return (
    <SettingBox
      style={{ marginTop: mode === "flyout" ? 0 : "20px" }}
      show_header={mode !== "flyout"}
      icon={"plus-circle"}
      title={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
            gap: "10px",
          }}
        >
          <span>
            &nbsp;
            <FormattedMessage
              id="project.new-file-page.title"
              defaultMessage={"New"}
            />
          </span>
          {renderActionButtons()}
        </div>
      }
      subtitle={renderCreateScopeBar()}
      close={mode === "flyout" ? undefined : closeNewPage}
      bodyStyle={mode === "flyout" ? { padding: 12 } : undefined}
    >
      <Modal
        onCancel={() => setCreatingFile("")}
        open={!!creatingFile}
        title={`Creating ${creatingFile}...`}
        footer={<></>}
      >
        <div style={{ textAlign: "center" }}>
          <Loading estimate={1000} />
        </div>
      </Modal>
      {mode === "flyout" && renderFlyoutTopControls()}
      <Row key={"new-file-row"} gutter={[24, 12]}>
        <Col sm={24}>
          <div style={{ marginBottom: "6px", fontWeight: 600 }}>Filename</div>
          <div style={{ fontSize: "12px", opacity: 0.7, marginBottom: "8px" }}>
            Name of the file you’re about to create.
          </div>
          <div
            style={{
              display: "flex",
              gap: "8px",
              alignItems: "stretch",
              flexWrap: "wrap",
              flexDirection: mode === "flyout" ? "column" : undefined,
            }}
          >
            <Input
              size="large"
              ref={inputRef}
              autoFocus={autoFocusFilename}
              value={filename}
              disabled={extensionWarning}
              placeholder={
                "Name your file, folder, or a URL to download from..."
              }
              style={{
                flex: mode === "flyout" ? "0 1 auto" : "1 1 320px",
                width: "100%",
              }}
              onChange={(e) => {
                if (extensionWarning) {
                  setExtensionWarning(false);
                } else {
                  setFilenameChanged(true);
                  setFilename(e.target.value);
                }
              }}
              onPressEnter={() => submit()}
            />
            {renderCreate()}
          </div>
          {extensionWarning && renderNoExtensionAlert()}
          {file_creation_error && renderError()}
        </Col>
      </Row>
      <Row gutter={[24, 16]} style={{ marginTop: "16px" }}>
        <Col md={24} sm={24}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginBottom: "8px",
            }}
          >
            <h3 style={{ margin: 0 }}>Quick Create</h3>
            <Button size="small" onClick={() => setShowCustomizeModal(true)}>
              Customize
            </Button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {quickCreateSpecs.map((spec) => (
              <NewFileButton
                key={spec.id}
                name={spec.label}
                ext={spec.ext}
                size="small"
                mode="secondary"
                icon={spec.icon}
                on_click={quickCreate}
              />
            ))}
          </div>
          <div style={{ marginTop: "12px" }}>
            <h4 style={{ marginBottom: "6px" }}>More file types</h4>
            <div
              style={{
                display: "flex",
                gap: "8px",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {/* No placeholder: Ant Design fades it out after hide, and the header already labels this control. */}
              <Select<string>
                showSearch
                allowClear
                style={{ flex: "1 1 260px", minWidth: "200px" }}
                value={undefined}
                options={moreFileTypeOptions}
                onSelect={(value: string) => {
                  quickCreate(value);
                }}
              />
              <Space size={6}>
                <Button
                  size="small"
                  onClick={() => createFile()}
                  disabled={
                    !filename.trim() ||
                    filename.endsWith("/") ||
                    !!filename_extension(filename) ||
                    is_only_downloadable(filename)
                  }
                >
                  <Icon name="file" /> File with no extension
                </Button>
              </Space>
            </div>
          </div>
          <div style={{ marginTop: "12px" }}>
            <h4 style={{ marginBottom: "6px" }}>Filename generator</h4>
            <SelectorInput
              style={{ width: "100%" }}
              selected={selectedFilenameFamily}
              options={NewFilenameFamilies}
              on_change={setNewFilenameFamily}
            />
          </div>
        </Col>
      </Row>
      <LauncherCustomizeModal
        open={showCustomizeModal}
        onClose={() => setShowCustomizeModal(false)}
        initialQuickCreate={mergedLauncher.quickCreate}
        onSave={saveUserLauncherPrefs}
      />
      <Modal
        open={showUploadModal}
        onCancel={() => setShowUploadModal(false)}
        title="Upload files"
        footer={null}
        destroyOnHidden
      >
        <FileUpload
          project_id={project_id}
          current_path={effective_current_path}
          show_header={false}
        />
      </Modal>
      <Modal
        open={showFolderModal}
        onCancel={() => setShowFolderModal(false)}
        title="Create folder"
        okText="Create"
        onOk={() => createFolder(folderName)}
        okButtonProps={{ disabled: !folderName.trim() }}
        confirmLoading={creatingFolder}
        destroyOnHidden
      >
        <div style={{ marginBottom: "6px", fontWeight: 600 }}>Folder name</div>
        <Input
          ref={folderInputRef}
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          onPressEnter={() => createFolder(folderName)}
        />
      </Modal>
    </SettingBox>
  );
}
