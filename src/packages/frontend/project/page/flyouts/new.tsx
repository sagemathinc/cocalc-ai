/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Flex, Input, Select, Space, Tag } from "antd";
import { FormattedMessage, useIntl } from "react-intl";

import { default_filename } from "@cocalc/frontend/account";
import {
  React,
  redux,
  useActions,
  useEffect,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  ErrorDisplay,
  HelpIcon,
  Icon,
  IconName,
  Paragraph,
  SelectorInput,
} from "@cocalc/frontend/components";
import ProgressEstimate from "@cocalc/frontend/components/progress-estimate";
import { file_options } from "@cocalc/frontend/editor-tmp";
import { file_associations } from "@cocalc/frontend/file-associations";
import { PathNavigator } from "@cocalc/frontend/project/explorer/path-navigator";
import {
  NEW_FILETYPE_ICONS,
  isNewFiletypeIconName,
} from "@cocalc/frontend/project/new/consts";
import { NewFileButton } from "@cocalc/frontend/project/new/new-file-button";
import { NewFileDropdown } from "@cocalc/frontend/project/new/new-file-dropdown";
import { LauncherCustomizeModal } from "@cocalc/frontend/project/new/launcher-customize-modal";
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
} from "@cocalc/frontend/project/new/launcher-preferences";
import {
  APP_CATALOG,
  APP_MAP,
  QUICK_CREATE_MAP,
} from "@cocalc/frontend/project/new/launcher-catalog";
import { useAvailableFeatures } from "@cocalc/frontend/project/use-available-features";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { NewFilenameFamilies } from "@cocalc/frontend/project/utils";
import { DEFAULT_NEW_FILENAMES, NEW_FILENAMES } from "@cocalc/util/db-schema";
import { keys, separate_file_extension, trunc_middle } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { FIX_BORDER } from "../common";
import { DEFAULT_EXT, FLYOUT_PADDING } from "./consts";
import { NamedServerPanel } from "@cocalc/frontend/project/named-server-panel";
import type { NamedServerName } from "@cocalc/util/types/servers";

function getFileExtension(filename: string): string | null {
  if (filename.endsWith(".")) {
    return null; // null signals no extension
  }
  return separate_file_extension(filename).ext;
}

function isFile(fn: string) {
  return !(fn && fn.endsWith("/"));
}

export function NewFlyout({
  project_id,
  wrap,
  defaultExt = DEFAULT_EXT,
}: {
  project_id: string;
  wrap: Function;
  defaultExt?: string;
}): React.JSX.Element {
  const intl = useIntl();
  const other_settings = useTypedRedux("account", "other_settings");
  const account_id = useTypedRedux("account", "account_id");
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
  const project_launcher = useTypedRedux(
    "projects",
    "project_map",
  )?.getIn([project_id, "launcher"]);
  const user_group = useTypedRedux("projects", "project_map")?.getIn([
    project_id,
    "users",
    account_id,
    "group",
  ]);
  const is_admin = useTypedRedux("account", "is_admin");
  const can_edit_project_defaults = !!is_admin || user_group === "owner";
  const student_project_functionality =
    useStudentProjectFunctionality(project_id);
  const rfn = other_settings.get(NEW_FILENAMES);
  const selected = rfn ?? DEFAULT_NEW_FILENAMES;
  const actions = useActions({ project_id });
  const current_path = useTypedRedux({ project_id }, "current_path");
  const availableFeatures = useAvailableFeatures(project_id);
  const file_creation_error = useTypedRedux(
    { project_id },
    "file_creation_error",
  );

  // the controlled value in the filename/basename input box
  const [filename, setFilename] = useState<string>("");
  // once the user starts fiddling around in that box, we switch to manually generated filenames
  const [manual, setManual] = useState<boolean>(false);
  // we set this to the default to visually highlight the button
  const [ext, setExt] = useState<string>(defaultExt);
  // if this is true, the entered filename contains a ".ext"
  const [manualExt, setManualExt] = useState<boolean>(false);
  // if true, creating a file is currently in progress
  const [creating, setCreating] = useState<boolean>(false);
  const [showCustomizeModal, setShowCustomizeModal] = useState<boolean>(false);
  const [showServerPanel, setShowServerPanel] = useState<"" | NamedServerName>(
    "",
  );

  const projectLauncherDefaults = getProjectLauncherDefaults(project_launcher);
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

  function saveUserLauncherPrefs(prefs: any | null) {
    const next = updateUserLauncherPrefs(
      other_settings?.get?.(LAUNCHER_SETTINGS_KEY),
      project_id,
      prefs,
    );
    redux.getActions("account").set_other_settings(LAUNCHER_SETTINGS_KEY, next);
  }

  async function saveProjectLauncherDefaults(prefs: any) {
    await redux.getActions("projects").set_project_launcher(project_id, prefs);
  }

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

  const quickCreateSpecs = mergedLauncher.quickCreate
    .filter((id) => id !== "sage")
    .filter(isQuickCreateAvailable)
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
    });
  const moreFileTypeOptions = React.useMemo(() => {
    const list = keys(file_associations).sort();
    const seen = new Set<string>();
    const options: { value: string; label: React.ReactNode }[] = [];
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
  const appSpecs = mergedLauncher.apps
    .filter((id) => APP_CATALOG.find((app) => app.id === id))
    .filter((id): id is NamedServerName => APP_MAP[id] != null)
    .filter(isAppVisible)
    .filter((id) => {
      if (visibleAppsSeen.has(id)) return false;
      visibleAppsSeen.add(id);
      return true;
    })
    .map((id) => APP_MAP[id]);

  // generate a new filename on demand, depends on the selected extension, existing files in the current directory, etc.
  function getNewFilename(ext: string): string {
    if (ext != "/") {
      const fullname = manual
        ? `${filename}.${ext}`
        : default_filename(ext, project_id);
      const { name } = separate_file_extension(fullname);
      return name;
    } else {
      return manual ? `${filename}/` : default_filename("/", project_id);
    }
  }

  // if name is entered manually and contains an extension, set the ext to it
  useEffect(() => {
    if (manual) {
      if (filename.endsWith("/")) {
        setExt("/");
      } else {
        if (filename.includes(".")) {
          setManualExt(true);
          const newExt = getFileExtension(filename);
          if (newExt == null) {
            setExt("");
          } else {
            setExt(newExt);
          }
        } else {
          // directory mode → escape back to no extension
          if (ext === "/") {
            setExt("");
          }
        }
      }
    } else {
      setManualExt(false);
    }
  }, [filename, manual]);

  // used to compute the filename to create, based on the current state
  function genNewFilename(): string {
    if (filename === "") return "";
    if (isFile(filename) && ext !== "/") {
      if (manualExt) {
        // extension is typed in explicitly
        return filename;
      } else {
        if (ext === "") {
          if (filename.endsWith(" ")) {
            // if we trigger the "no extension" with a space, trim the name
            // otherwise, use the no extension creation button
            return filename.trim();
          } else {
            return filename;
          }
        } else {
          return `${filename}.${ext}`;
        }
      }
    } else {
      if (filename.endsWith("/")) {
        return filename;
      } else {
        return `${filename}/`;
      }
    }
  }

  async function createFile(fn: string) {
    if (!fn) return; // do nothing for an empty string
    const { name: newFilename, ext } = separate_file_extension(fn);

    try {
      setCreating(true);
      if (isFile(fn)) {
        await actions?.createFile({
          name: newFilename.trim(),
          ext: ext.trim(),
          current_path,
        });
      } else {
        await actions?.createFolder({
          name: newFilename.trim(),
          current_path,
        });
      }
      // success: reset the manual flag
      setManual(false);
      // and reset the filename and extension to the defaults
      setFilename("");
    } finally {
      // upon error, we keep the state as is, so the user can retry
      setCreating(false);
    }
  }

  function onKeyUpHandler(e) {
    switch (e.key) {
      case "Enter":
        createFile(manualExt ? filename : `${filename}.${ext}`);
        break;
      case "Escape":
        setFilename("");
        break;
    }
  }

  function onChangeHandler(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    if (val) {
      setManual(true);
      setFilename(val);
    } else {
      setManual(false);
      setFilename("");
    }
  }

  function fileIcon() {
    const name: IconName = isNewFiletypeIconName(ext)
      ? NEW_FILETYPE_ICONS[ext!]
      : file_options(`foo.${ext}`)?.icon ?? "file";
    return (
      <Icon
        name={name}
        style={{ fontSize: "150%", marginRight: FLYOUT_PADDING }}
      />
    );
  }

  function handleOnClick(nextExt: string) {
    let fn = getNewFilename(nextExt);
    if (nextExt !== "/") {
      // if we had a "/" at the end and now we don't, remove it from the base filename
      fn = fn.endsWith("/") ? fn.slice(0, fn.length - 1) : fn;
      // if there is an extension in the filename, replace it with the new one
      const { ext: oldExt, name } = separate_file_extension(fn);
      if (oldExt !== nextExt) {
        if (nextExt === "") {
          fn = name; // we avoid appending a silly dot
        } else {
          fn = `${name}.${nextExt}`;
        }
      }
    } else if (nextExt === "/" && !fn.endsWith("/")) {
      fn = `${fn}/`;
    }
    // set the new extension
    setExt(nextExt);
    createFile(fn);
  }

  function getRenderErrorMessage() {
    const error = file_creation_error;
    if (error === "not running") {
      return "The project is not running. Please try again in a moment";
    } else {
      return error;
    }
  }

  function renderError() {
    return (
      <ErrorDisplay
        style={{ margin: 0, flex: "1 0 auto" }}
        banner={true}
        error={getRenderErrorMessage()}
        onClose={(): void => {
          actions?.setState({ file_creation_error: "" });
        }}
      />
    );
  }

  function inputOnFocus(e: React.FocusEvent<HTMLInputElement>) {
    e.target.select();
  }

  function handleNewExtDropdown(ext: string) {
    const nextExt = ext ?? "";
    if (manualExt) {
      // have explicit extension in name, but just changed it
      // via dropdown, so better remove it from the name.
      const { name } = separate_file_extension(filename);
      setFilename(name);
      setManualExt(false);
    } else {
      const fn = getNewFilename(nextExt);
      setFilename(fn);
    }
    setExt(nextExt);
  }

  function renderExtAddon(): React.JSX.Element {
    const title = ext === "/" ? `/` : ext === "" ? "" : `.${ext}`;
    return (
      <NewFileDropdown
        mode="flyout"
        create_file={handleNewExtDropdown}
        title={title}
        showDown
        button={false}
        cacheKey={`${manual}-${manualExt}-${filename}-${ext}`}
      />
    );
  }

  function renderCreateFileButton() {
    const newFilename = genNewFilename();
    const { name, ext } = separate_file_extension(newFilename);
    const renderedExt =
      name && ext && isFile(newFilename) && ext !== "/" ? `.${ext}` : "";
    const disabled = creating || !name || name === "/";
    return (
      <Flex dir="horizontal">
        <Button
          type="primary"
          disabled={disabled}
          onClick={() => createFile(newFilename)}
          block
          style={{ flex: "1" }}
        >
          <span style={{ whiteSpaceCollapse: "preserve" } as any}>
            <span>
              <FormattedMessage
                id="project.page.flyouts.new.create.label"
                defaultMessage={"Create"}
                description={
                  "Create a file with the given name in a file-system"
                }
              />
            </span>{" "}
            <span
              style={{
                fontWeight: "bold",
                color: disabled ? undefined : "white",
              }}
            >
              {trunc_middle(name, 30)}
            </span>
            {renderedExt}
          </span>
        </Button>
        <HelpIcon
          title={intl.formatMessage({
            id: "project.page.flyouts.new.create.help.title",
            defaultMessage: "Creating files and folders",
          })}
          style={{
            flex: "0 1 auto",
            padding: FLYOUT_PADDING,
            fontSize: "18px",
          }}
        >
          <FormattedMessage
            id="project.page.flyouts.new.create.help.message"
            description={
              "Help information about creating a file in a file-system"
            }
            defaultMessage={`
              <Paragraph>
                The filename is optional. If you don't specify one, a default name
                will be create for you. You can either select the type explicitly in
                the dropdown above, or click on one of the buttons below. These
                buttons will create the file or folder immediately.
              </Paragraph>
              <Paragraph>
                New folders (directories) are created by typing in the name and
                clicking on "Folder" below or by adding a "/" at the end of the
                name. Such a forward-slash is used to indicate directories on Linux
                – that's the underlying operating system.
              </Paragraph>
              <Paragraph>
                You can also just type in the filename with the extension and press Enter to create the file.
              </Paragraph>
          `}
            values={{ Paragraph: (c) => <Paragraph>{c}</Paragraph> }}
          />
        </HelpIcon>
      </Flex>
    );
  }

  function renderHead() {
    const padding = { padding: FLYOUT_PADDING };
    return (
      <Space orientation="vertical">
        <Space orientation="horizontal" style={padding}>
          <FormattedMessage
            id="project.page.flyouts.new.header_location"
            defaultMessage={"Location:"}
            description={"The directory location of files in a file-system"}
          />{" "}
          <PathNavigator
            mode={"flyout"}
            project_id={project_id}
            className={"cc-project-flyout-path-navigator"}
          />
        </Space>
        <Input
          allowClear
          placeholder={intl.formatMessage({
            id: "project.page.flyouts.new.filename.placeholder",
            defaultMessage: "Filename (optional)",
          })}
          value={filename}
          onChange={onChangeHandler}
          onKeyUp={onKeyUpHandler}
          onFocus={inputOnFocus}
          style={{ width: "100%", ...padding }}
          addonBefore={fileIcon()}
          addonAfter={renderExtAddon()}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            ...padding,
          }}
        >
          {renderCreateFileButton()}
          {creating && <ProgressEstimate seconds={5} />}
        </div>
        {file_creation_error && renderError()}
      </Space>
    );
  }

  function renderBody() {
    return (
      <Space
        style={{ width: "100%", overflowX: "hidden", padding: FLYOUT_PADDING }}
        orientation="vertical"
      >
        <Flex justify="space-between" align="center">
          <Tag color="blue">Quick Create</Tag>
          <Button size="small" onClick={() => setShowCustomizeModal(true)}>
            Customize
          </Button>
        </Flex>
        <Flex gap={6} wrap>
          {quickCreateSpecs.map((spec) => (
            <NewFileButton
              key={`flyout-quick-${spec.id}`}
              name={spec.label}
              ext={spec.ext}
              icon={spec.icon}
              size="small"
              mode="secondary"
              on_click={handleOnClick}
            />
          ))}
        </Flex>
        <div style={{ marginTop: "8px" }}>
          <div style={{ marginBottom: "6px", fontWeight: 500 }}>More file types</div>
          <div style={{ display: "flex", gap: "8px", flexDirection: "column" }}>
            <Select<string>
              showSearch
              allowClear
              placeholder="Search file types..."
              style={{ width: "100%" }}
              value={undefined}
              options={moreFileTypeOptions}
              onSelect={(value: string) => handleOnClick(value)}
            />
            <Flex gap={8} wrap>
              <Button
                size="small"
                onClick={() => handleOnClick("/")}
                disabled={!filename.trim()}
              >
                <Icon name="folder" /> Create folder
              </Button>
              <Button
                size="small"
                onClick={() => handleOnClick("")}
                disabled={!filename.trim() || filename.endsWith("/")}
              >
                <Icon name="file" /> File with no extension
              </Button>
            </Flex>
          </div>
        </div>
        <Flex justify="space-between" align="center" style={{ marginTop: "4px" }}>
          <Tag color="geekblue">Apps</Tag>
        </Flex>
        <Flex gap={6} wrap>
          {appSpecs.map((app) => (
            <NewFileButton
              key={`flyout-app-${app.id}`}
              name={app.label}
              icon={app.icon}
              size="small"
              mode="secondary"
              on_click={() => setShowServerPanel(app.id)}
            />
          ))}
        </Flex>
        {showServerPanel && (
          <NamedServerPanel project_id={project_id} name={showServerPanel} />
        )}
        <hr />
        <Tag color={COLORS.GRAY_L}>Filename generator</Tag>
        <SelectorInput
          style={{ width: "100%", color: COLORS.GRAY }}
          selected={selected}
          options={NewFilenameFamilies}
          on_change={(family) => actions?.set_new_filename_family(family)}
        />
      </Space>
    );
  }

  function renderBottom(): React.JSX.Element {
    return (
      <Space
        style={{
          flex: "1 0 auto",
          width: "100%",
          overflowX: "hidden",
          overflowY: "hidden",
          padding: FLYOUT_PADDING,
          borderTop: FIX_BORDER,
        }}
        orientation="vertical"
      >
        {renderCreateFileButton()}
      </Space>
    );
  }

  return (
    <>
      {renderHead()}
      {wrap(renderBody())}
      {renderBottom()}
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
    </>
  );
}
