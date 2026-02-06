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
  useActions,
  useRedux,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  ErrorDisplay,
  Icon,
  Loading,
  Paragraph,
  SettingBox,
  Tip,
} from "@cocalc/frontend/components";
import { filenameIcon, file_associations } from "@cocalc/frontend/file-associations";
import type { IconName } from "@cocalc/frontend/components/icon";
import { FileUpload } from "@cocalc/frontend/file-upload";
import { labels } from "@cocalc/frontend/i18n";
import { special_filenames_with_no_extension } from "@cocalc/frontend/project-file";
import { getValidActivityBarOption } from "@cocalc/frontend/project/page/activity-bar";
import { ACTIVITY_BAR_KEY } from "@cocalc/frontend/project/page/activity-bar-consts";
import { filename_extension, is_only_downloadable, keys } from "@cocalc/util/misc";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import type { NamedServerName } from "@cocalc/util/types/servers";
import { PathNavigator } from "../explorer/path-navigator";
import { useAvailableFeatures } from "../use-available-features";
import { NewFileButton } from "./new-file-button";
import { AIGenerateDocumentModal } from "../page/home-page/ai-generate-document";
import { Ext } from "../page/home-page/ai-generate-examples";
import {
  APP_CATALOG,
  APP_MAP,
  QUICK_CREATE_MAP,
} from "./launcher-catalog";
import { file_options } from "@cocalc/frontend/editor-tmp";
import {
  LAUNCHER_GLOBAL_DEFAULTS,
  LAUNCHER_SITE_REMOVE_APPS_KEY,
  LAUNCHER_SITE_REMOVE_QUICK_KEY,
  LAUNCHER_SITE_DEFAULTS_APPS_KEY,
  LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  LAUNCHER_SETTINGS_KEY,
  getProjectLauncherDefaults,
  getSiteLauncherDefaults,
  getUserLauncherLayers,
  mergeLauncherSettings,
  updateUserLauncherPrefs,
} from "./launcher-preferences";
import { LauncherCustomizeModal } from "./launcher-customize-modal";
import { NamedServerPanel } from "../named-server-panel";
import { lite } from "@cocalc/frontend/lite";
import { NavigatorShell } from "./navigator-shell";

const CREATE_MSG = defineMessage({
  id: "project.new.new-file-page.create.title",
  defaultMessage: `Create {desc}`,
  description: "creating a file with the given description in a file-system",
});

interface Props {
  project_id: string;
  initialFilename?: string;
  autoFocusFilename?: boolean;
}

export default function NewFilePage(props: Props) {
  const intl = useIntl();
  const { project_id, initialFilename, autoFocusFilename = true } = props;
  const inputRef = useRef<any>(null);
  useEffect(() => {
    if (!autoFocusFilename) return;
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, 1);
  }, [autoFocusFilename]);
  const actions = useActions({ project_id });
  const availableFeatures = useAvailableFeatures(project_id);
  const student_project_functionality =
    useStudentProjectFunctionality(project_id);
  const other_settings = useTypedRedux("account", "other_settings");
  const account_id = useTypedRedux("account", "account_id");
  const is_admin = useTypedRedux("account", "is_admin");
  const site_launcher_quick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_QUICK_KEY,
  );
  const site_launcher_apps = useTypedRedux(
    "customize",
    LAUNCHER_SITE_DEFAULTS_APPS_KEY,
  );
  const site_remove_quick = useTypedRedux(
    "customize",
    LAUNCHER_SITE_REMOVE_QUICK_KEY,
  );
  const site_remove_apps = useTypedRedux(
    "customize",
    LAUNCHER_SITE_REMOVE_APPS_KEY,
  );
  const project_launcher = useRedux([
    "projects",
    "project_map",
    project_id,
    "launcher",
  ]);
  const user_group = useRedux([
    "projects",
    "project_map",
    project_id,
    "users",
    account_id,
    "group",
  ]);
  const can_edit_project_defaults =
    !!is_admin || user_group === "owner";
  const [extensionWarning, setExtensionWarning] = useState<boolean>(false);
  const current_path = useTypedRedux({ project_id }, "current_path");
  const filename0 = useTypedRedux({ project_id }, "default_filename");
  const fallbackFilename = filename0
    ? filename0
    : default_filename(undefined, project_id);
  const [filename, setFilename] = useState<string>(
    initialFilename?.trim() ? initialFilename : fallbackFilename,
  );
  useEffect(() => {
    if (initialFilename === undefined) return;
    setFilename(initialFilename.trim() ? initialFilename : fallbackFilename);
  }, [initialFilename, fallbackFilename]);
  const [aiPrompt, setAiPrompt] = useState<string>("");
  const [aiExt, setAiExt] = useState<Ext>("ipynb");
  const [showAiModal, setShowAiModal] = useState<boolean>(false);
  const [showCustomizeModal, setShowCustomizeModal] =
    useState<boolean>(false);
  const [showUploadModal, setShowUploadModal] = useState<boolean>(false);
  const [showServerPanel, setShowServerPanel] = useState<"" | NamedServerName>(
    "",
  );
  const file_creation_error = useTypedRedux(
    { project_id },
    "file_creation_error",
  );
  if (actions == null) {
    return <Loading theme="medium" />;
  }

  const projectLauncherDefaults = getProjectLauncherDefaults(
    project_launcher,
  );
  const siteLauncherDefaults = getSiteLauncherDefaults({
    quickCreate: site_launcher_quick,
    apps: site_launcher_apps,
    hiddenQuickCreate: site_remove_quick,
    hiddenApps: site_remove_apps,
  });
  const userLauncherLayers = getUserLauncherLayers(
    other_settings?.get?.(LAUNCHER_SETTINGS_KEY),
    project_id,
  );
  const navigator_target_project_id = other_settings?.get?.(
    "navigator_target_project_id",
  );
  const inheritedForProjectUser = mergeLauncherSettings({
    globalDefaults: siteLauncherDefaults,
    projectDefaults: projectLauncherDefaults,
    accountUserPrefs: userLauncherLayers.account,
  });
  const inheritedForProjectDefaults = mergeLauncherSettings({
    globalDefaults: siteLauncherDefaults,
  });
  const mergedLauncher = mergeLauncherSettings({
    globalDefaults: siteLauncherDefaults,
    projectDefaults: projectLauncherDefaults,
    accountUserPrefs: userLauncherLayers.account,
    projectUserPrefs: userLauncherLayers.project,
  });

  function isQuickCreateAvailable(id: string): boolean {
    switch (id) {
      case "ipynb":
        return availableFeatures.jupyter_notebook;
      case "sage":
        return availableFeatures.sage;
      case "tex":
        return availableFeatures.latex;
      case "qmd":
        return availableFeatures.qmd;
      case "rmd":
        return availableFeatures.rmd;
      default:
        return true;
    }
  }

  function isAppVisible(id: NamedServerName): boolean {
    switch (id) {
      case "jupyterlab":
        return !student_project_functionality.disableJupyterLabServer;
      case "jupyter":
        return !student_project_functionality.disableJupyterClassicServer;
      case "code":
        return !student_project_functionality.disableVSCodeServer;
      case "pluto":
        return !student_project_functionality.disablePlutoServer;
      case "rserver":
        return !student_project_functionality.disableRServer;
      default:
        return true;
    }
  }

  const quickCreateIds = mergedLauncher.quickCreate
    .filter((id) => id !== "sage")
    .filter(isQuickCreateAvailable);
  const quickCreateSpecs = quickCreateIds
    .map((id) => {
      const spec = QUICK_CREATE_MAP[id];
      if (spec) return spec;
      const data = file_options(`x.${id}`);
      return {
        id,
        ext: id,
        label: data.name ?? id,
        icon: data.icon ?? "file",
      };
    })
    .filter(Boolean);

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
            <Icon name={icon} /> {info.name ?? value}{" "}
            <span style={{ opacity: 0.6 }}>({value})</span>
          </span>
        ),
      });
    }
    return options;
  }, []);

  const visibleAppsSeen = new Set<NamedServerName>();
  const appIds = mergedLauncher.apps.filter(
    (id) => APP_CATALOG.find((app) => app.id === id) != null,
  ) as NamedServerName[];
  const visibleApps = appIds.filter(isAppVisible).filter((id) => {
    if (visibleAppsSeen.has(id)) return false;
    visibleAppsSeen.add(id);
    return true;
  });
  const appSpecs = visibleApps
    .map((id) => APP_MAP[id])
    .filter(Boolean) as { id: NamedServerName; label: string; icon: IconName }[];
  const serversDisabled: boolean =
    !!student_project_functionality.disableJupyterLabServer &&
    !!student_project_functionality.disableJupyterClassicServer &&
    !!student_project_functionality.disableVSCodeServer &&
    !!student_project_functionality.disablePlutoServer &&
    !!student_project_functionality.disableRServer;

  function getActions(): ProjectActions {
    if (actions == null) throw new Error("bug");
    return actions;
  }

  function saveUserLauncherPrefs(prefs: any | null) {
    const next = updateUserLauncherPrefs(
      other_settings?.get?.(LAUNCHER_SETTINGS_KEY),
      project_id,
      prefs,
    );
    redux.getActions("account").set_other_settings(LAUNCHER_SETTINGS_KEY, next);
  }

  async function saveProjectLauncherDefaults(prefs: any) {
    await redux
      .getActions("projects")
      .set_project_launcher(project_id, prefs);
  }

  const [creatingFile, setCreatingFile] = useState<string>("");

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
        current_path,
      });
    } finally {
      setCreatingFile("");
    }
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
      const next =
        filename0 ? filename0 : default_filename(ext, project_id);
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

  function createFolder() {
    getActions().createFolder({
      name: filename,
      current_path,
      switch_over: true,
    });
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

  //key is so autofocus works below
  return (
    <SettingBox
      style={{ marginTop: "20px" }}
      show_header
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
              defaultMessage={"Create"}
            />
          </span>
          <Button size="small" onClick={() => setShowUploadModal(true)}>
            <Icon name="cloud-upload" /> Upload
          </Button>
        </div>
      }
      subtitle={
        <div>
          <PathNavigator
            project_id={project_id}
            style={{ display: "inline-block", fontSize: "20px" }}
          />
        </div>
      }
      close={closeNewPage}
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
      <Row key={"new-file-row"} gutter={[24, 12]}>
        <Col sm={24}>
          <div style={{ marginBottom: "6px", fontWeight: 600 }}>
            Filename
          </div>
          <div style={{ fontSize: "12px", opacity: 0.7, marginBottom: "8px" }}>
            Name of the file you’re about to create.
          </div>
          <div
            style={{
              display: "flex",
              gap: "8px",
              alignItems: "stretch",
              flexWrap: "wrap",
            }}
          >
            <Input
              size="large"
              ref={inputRef}
              autoFocus={autoFocusFilename}
              value={filename}
              disabled={extensionWarning}
              placeholder={"Name your file, folder, or a URL to download from..."}
              style={{ flex: "1 1 320px" }}
              onChange={(e) => {
                if (extensionWarning) {
                  setExtensionWarning(false);
                } else {
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
        <Col md={14} sm={24}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
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
              <Select<string>
                showSearch
                allowClear
                placeholder="Search file types..."
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
                  onClick={() => createFolder()}
                  disabled={!filename.trim()}
                >
                  <Icon name="folder" /> Create folder
                </Button>
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
        </Col>
        <Col md={10} sm={24}>
          <h3 style={{ marginTop: 0 }}>Create with AI</h3>
          <Space.Compact style={{ width: "100%" }}>
            <Input
              size="large"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="Describe what you want to create..."
              onPressEnter={() => {
                if (aiPrompt.trim()) {
                  setShowAiModal(true);
                }
              }}
            />
            <Select
              size="large"
              value={aiExt}
              onChange={(value) => setAiExt(value)}
              style={{ minWidth: "120px" }}
              options={[
                availableFeatures.jupyter_notebook
                  ? { value: "ipynb", label: "Notebook" }
                  : undefined,
                availableFeatures.sage
                  ? { value: "ipynb-sagemath", label: "SageMath Notebook" }
                  : undefined,
                { value: "md", label: "Markdown" },
                availableFeatures.latex ? { value: "tex", label: "LaTeX" } : undefined,
                availableFeatures.qmd ? { value: "qmd", label: "Quarto" } : undefined,
                availableFeatures.rmd ? { value: "rmd", label: "RMarkdown" } : undefined,
              ].filter(Boolean) as { value: Ext; label: string }[]}
            />
            <Button
              size="large"
              type="primary"
              onClick={() => setShowAiModal(true)}
              disabled={!aiPrompt.trim()}
            >
              Create
            </Button>
          </Space.Compact>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginTop: "16px",
              marginBottom: "6px",
            }}
          >
            <h4 style={{ margin: 0 }}>Apps</h4>
            <Button size="small" onClick={() => setShowCustomizeModal(true)}>
              Customize
            </Button>
          </div>
          <Space wrap>
            {appSpecs.map((spec) => (
              <NewFileButton
                key={`app-${spec.id}`}
                name={spec.label}
                icon={spec.icon}
                size="small"
                mode="secondary"
                on_click={() => setShowServerPanel(spec.id)}
              />
            ))}
            {serversDisabled && (
              <Button
                size="small"
                onClick={() =>
                  Modal.info({
                    title: "Servers disabled",
                    content:
                      "App servers are disabled in this workspace. Contact your administrator to enable them.",
                  })
                }
              >
                <Icon name="exclamation-circle" /> Servers disabled
              </Button>
            )}
          </Space>
          {lite ? (
            <NavigatorShell
              project_id={project_id}
              defaultTargetProjectId={
                typeof navigator_target_project_id === "string"
                  ? navigator_target_project_id
                  : undefined
              }
            />
          ) : null}
        </Col>
      </Row>
      <LauncherCustomizeModal
        open={showCustomizeModal}
        onClose={() => setShowCustomizeModal(false)}
        initialQuickCreate={mergedLauncher.quickCreate}
        initialApps={mergedLauncher.apps as NamedServerName[]}
        userBaseQuickCreate={inheritedForProjectUser.quickCreate}
        userBaseApps={inheritedForProjectUser.apps as NamedServerName[]}
        projectBaseQuickCreate={inheritedForProjectDefaults.quickCreate}
        projectBaseApps={inheritedForProjectDefaults.apps as NamedServerName[]}
        globalDefaults={siteLauncherDefaults}
        onSaveUser={saveUserLauncherPrefs}
        onSaveProject={saveProjectLauncherDefaults}
        canEditProjectDefaults={can_edit_project_defaults}
        contributions={[
          {
            key: "built-in",
            title: "Built-in defaults",
            quickCreateAdd: LAUNCHER_GLOBAL_DEFAULTS.quickCreate,
            appsAdd: LAUNCHER_GLOBAL_DEFAULTS.apps,
          },
          {
            key: "site",
            title: "Site defaults",
            quickCreateAdd: siteLauncherDefaults.quickCreate,
            quickCreateRemove: siteLauncherDefaults.hiddenQuickCreate,
            appsAdd: siteLauncherDefaults.apps,
            appsRemove: siteLauncherDefaults.hiddenApps,
          },
          {
            key: "project",
            title: "Workspace defaults",
            quickCreateAdd: projectLauncherDefaults.quickCreate,
            quickCreateRemove: projectLauncherDefaults.hiddenQuickCreate,
            appsAdd: projectLauncherDefaults.apps,
            appsRemove: projectLauncherDefaults.hiddenApps,
          },
          {
            key: "account",
            title: "Your account overrides",
            quickCreateAdd: userLauncherLayers.account.quickCreate,
            quickCreateRemove: userLauncherLayers.account.hiddenQuickCreate,
            appsAdd: userLauncherLayers.account.apps,
            appsRemove: userLauncherLayers.account.hiddenApps,
          },
          {
            key: "workspace-user",
            title: "This workspace overrides",
            quickCreateAdd: userLauncherLayers.project.quickCreate,
            quickCreateRemove: userLauncherLayers.project.hiddenQuickCreate,
            appsAdd: userLauncherLayers.project.apps,
            appsRemove: userLauncherLayers.project.hiddenApps,
          },
        ]}
      />
      <AIGenerateDocumentModal
        project_id={project_id}
        show={showAiModal}
        setShow={setShowAiModal}
        ext={aiExt}
        initialPrompt={aiPrompt}
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
          current_path={current_path}
          show_header={false}
        />
      </Modal>
      <Modal
        open={!!showServerPanel}
        onCancel={() => setShowServerPanel("")}
        footer={null}
        width={820}
        destroyOnHidden
        title={showServerPanel ? APP_MAP[showServerPanel]?.label : undefined}
      >
        {showServerPanel && (
          <NamedServerPanel project_id={project_id} name={showServerPanel} />
        )}
      </Modal>
    </SettingBox>
  );
}
