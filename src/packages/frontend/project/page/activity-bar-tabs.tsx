/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Tabs in a particular project.
*/

import type { MenuProps } from "antd";
import { Button, Checkbox, Dropdown, Modal, Tooltip } from "antd";
import { debounce, throttle } from "lodash";
import {
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useIntl } from "react-intl";
import { CSS, useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import useAppContext from "@cocalc/frontend/app/use-context";
import { ChatIndicator } from "@cocalc/frontend/chat/chat-indicator";
import { Icon, type IconName } from "@cocalc/frontend/components";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import { useProjectContext } from "@cocalc/frontend/project/context";
import track from "@cocalc/frontend/user-tracking";
import { tab_to_path } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import {
  ACTIVITY_BAR_HIDDEN_TABS,
  ACTIVITY_BAR_LABELS,
  ACTIVITY_BAR_TAB_ORDER,
  ACTIVITY_BAR_TOGGLE_LABELS,
  TOGGLE_ACTIVITY_BAR_TOGGLE_BUTTON_SPACE,
} from "./activity-bar-consts";
import { FileTab, FIXED_PROJECT_TABS, FixedTab } from "./file-tab";
import FileTabs from "./file-tabs";
import { ShareIndicator } from "./share-indicator";
import { lite } from "@cocalc/frontend/lite";
import SettingsButton from "@cocalc/frontend/account/settings-button";
import { RemoteSshButton, SshButton } from "@cocalc/frontend/ssh";
import SshUpgradeButton from "@cocalc/frontend/ssh/ssh-upgrade-button";
import {
  type WorkspaceStrongThemeChrome,
  workspaceStrongThemeChrome,
} from "../workspaces/strong-theme";
import {
  getDefaultFixedTabOrder,
  getDefaultHiddenFixedTabs,
  moveFixedTab,
  normalizeFixedTabOrder,
  normalizeHiddenFixedTabs,
  splitRailTabs,
} from "./activity-bar-preferences";

const INDICATOR_STYLE: React.CSSProperties = {
  overflow: "hidden",
  paddingLeft: "5px",
} as const;

export const FIXED_TABS_BG_COLOR = "rgba(0, 0, 0, 0.02)";

interface PTProps {
  project_id: string;
}

export default function ProjectTabs(props: PTProps) {
  const { project_id } = props;
  const openFiles = useTypedRedux({ project_id }, "open_files_order");
  const activeTab = useTypedRedux({ project_id }, "active_project_tab");
  const sshRemoteTarget = useTypedRedux("customize", "ssh_remote_target");

  //if (openFiles.size == 0) return <></>;

  return (
    <div
      className="smc-file-tabs"
      style={{
        width: "100%",
        height: "40px",
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex" }}>
        <div
          style={{
            display: "flex",
            overflow: "hidden",
            flex: 1,
          }}
        >
          <FileTabs
            openFiles={openFiles}
            project_id={project_id}
            activeTab={activeTab}
          />
        </div>
        <div
          style={{
            display: "inline-flex",
            marginLeft: "-10px",
          }}
        >
          <ShareIndicatorTab activeTab={activeTab} project_id={project_id} />
          <ChatIndicatorTab activeTab={activeTab} project_id={project_id} />
        </div>
        {lite && (
          <>
            {sshRemoteTarget ? <RemoteSshButton /> : <SshButton />}
            <SshUpgradeButton />
            <SettingsButton />
          </>
        )}
      </div>
    </div>
  );
}

interface FVTProps {
  setHomePageButtonWidth: (width: number) => void;
}

export function VerticalFixedTabs({
  setHomePageButtonWidth,
}: Readonly<FVTProps>) {
  const intl = useIntl();
  const {
    actions,
    project_id,
    active_project_tab: activeTab,
    workspaces,
  } = useProjectContext();
  const account_settings = useActions("account");
  const { showActBarLabels } = useAppContext();
  const active_flyout = useTypedRedux({ project_id }, "flyout");
  const other_settings = useTypedRedux("account", "other_settings");
  const parent = useRef<HTMLDivElement>(null);
  const gap = useRef<HTMLDivElement>(null);
  const breakPoint = useRef<number>(0);
  const refCondensed = useRef<boolean>(false);
  const [condensed, setCondensed] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const workspaceChrome = workspaceStrongThemeChrome(workspaces.current);
  const tabOrder = useMemo(
    () =>
      normalizeFixedTabOrder(other_settings?.get?.(ACTIVITY_BAR_TAB_ORDER), {
        liteMode: lite,
      }),
    [other_settings],
  );
  const hiddenTabs = useMemo(
    () =>
      normalizeHiddenFixedTabs(
        other_settings?.get?.(ACTIVITY_BAR_HIDDEN_TABS),
        {
          liteMode: lite,
        },
      ),
    [other_settings],
  );
  const { visible: pinnedTabs, overflow: overflowTabs } = useMemo(
    () => splitRailTabs(tabOrder, hiddenTabs),
    [hiddenTabs, tabOrder],
  );

  const calcCondensed = throttle(
    () => {
      if (gap.current == null) return;
      if (parent.current == null) return;

      const gh = gap.current.clientHeight;
      const ph = parent.current.clientHeight;
      if (ph == 0) return;

      if (refCondensed.current) {
        // 5px slack to avoid flickering
        if (gh > 0 && ph > breakPoint.current + 5) {
          setCondensed(false);
          refCondensed.current = false;
        }
      } else {
        if (gh < 1) {
          setCondensed(true);
          refCondensed.current = true;
          breakPoint.current = ph;
        }
      }
    },
    50,
    { trailing: true, leading: false },
  );

  // layout effect, because it measures sizes before rendering
  useLayoutEffect(() => {
    calcCondensed();
    window.addEventListener("resize", calcCondensed);
    return () => {
      window.removeEventListener("resize", calcCondensed);
    };
  }, []);

  useEffect(() => {
    calcCondensed();
  }, [showActBarLabels, parent.current, gap.current]);

  useEffect(() => {
    if (parent.current == null) return;

    const observer = new ResizeObserver(
      debounce(
        () => {
          const width = parent.current?.offsetWidth;
          // we ignore zero width, which happens when not visible
          if (width == null || width == 0) return;
          setHomePageButtonWidth(width);
        },
        50,
        { trailing: true, leading: false },
      ),
    );
    observer.observe(parent.current);

    return () => {
      observer.disconnect();
    };
  }, [condensed, showActBarLabels, parent.current, gap.current]);

  const items: ReactNode[] = [];
  for (const name of pinnedTabs) {
    const color =
      activeTab == name
        ? { color: COLORS.PROJECT.FIXED_LEFT_ACTIVE }
        : undefined;

    const isActive = active_flyout === name;

    const style: CSS = {
      ...color,
      margin: "0",
      borderLeft: `4px solid ${
        isActive ? COLORS.PROJECT.FIXED_LEFT_ACTIVE : "transparent"
      }`,
      // highlight active flyout in flyout-only mode more -- see https://github.com/sagemathinc/cocalc/issues/6855
      ...(isActive ? { backgroundColor: COLORS.BLUE_LLLL } : undefined),
    };

    const spacing: string = showActBarLabels
      ? "5px"
      : condensed
        ? "8px" // margin for condensed mode
        : "12px"; // margin for normal mode
    const workspaceImage =
      name === "workspaces" && workspaces.current?.theme.image_blob?.trim()
        ? `/blobs/theme-image.png?uuid=${encodeURIComponent(
            workspaces.current.theme.image_blob.trim(),
          )}`
        : undefined;
    const iconName: IconName | undefined =
      name === "workspaces"
        ? (workspaces.current?.theme.icon?.trim() as IconName | undefined) ||
          undefined
        : undefined;
    const themedIconStyle =
      name === "workspaces" && workspaces.current?.theme.color
        ? { color: workspaces.current.theme.color }
        : undefined;

    const tab = (
      <FileTab
        style={style}
        placement={"right"}
        key={name}
        project_id={project_id}
        name={name as FixedTab}
        isFixedTab={true}
        iconStyle={{
          fontSize: condensed ? "18px" : "24px",
          margin: "0",
          ...color,
          ...themedIconStyle,
        }}
        iconName={iconName}
        imageUrl={workspaceImage}
        extraSpacing={spacing}
        flyout={name}
        condensed={condensed}
        showLabel={showActBarLabels}
      />
    );
    if (tab != null) items.push(tab);
  }

  function openOverflowTab(name: FixedTab): void {
    actions?.toggleFlyout(name);
    track("action-bar", {
      action: "open-overflow-flyout",
      name,
      project_id,
    });
  }

  function renderOverflowMenu(): ReactNode {
    if (overflowTabs.length === 0) return null;
    const isActive =
      active_flyout != null && overflowTabs.includes(active_flyout);
    const items: NonNullable<MenuProps["items"]> = overflowTabs.map((name) => ({
      key: name,
      label: (
        <span>
          <Icon name={FIXED_PROJECT_TABS[name].icon} />{" "}
          {renderFixedTabLabel(name, intl)}
        </span>
      ),
      onClick: () => openOverflowTab(name),
    }));
    return (
      <Tooltip title="More panels" placement="rightTop">
        <Dropdown menu={{ items }} trigger={["click"]} placement="topRight">
          <Button
            size="small"
            type="text"
            block
            style={{
              marginTop: "2px",
              marginBottom: "2px",
              borderLeft: `4px solid ${
                isActive ? COLORS.PROJECT.FIXED_LEFT_ACTIVE : "transparent"
              }`,
              background: isActive
                ? COLORS.BLUE_LLLL
                : workspaceChrome?.activityBarBackground,
              color: isActive ? COLORS.PROJECT.FIXED_LEFT_ACTIVE : undefined,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: showActBarLabels ? "flex-start" : "center",
                gap: showActBarLabels ? "8px" : undefined,
                minHeight: condensed ? "36px" : "40px",
              }}
            >
              <Icon
                name="ellipsis"
                rotate="90"
                style={{ fontSize: condensed ? "18px" : "24px" }}
              />
              {showActBarLabels ? <span>More</span> : null}
            </div>
          </Button>
        </Dropdown>
      </Tooltip>
    );
  }

  function renderToggleActivityBar() {
    return (
      <Tooltip
        title={intl.formatMessage({
          id: "project.page.activity-bar.hide.tooltip",
          defaultMessage: "Hide the activity bar",
          description: "This hides the vertical activity bar in the UI",
        })}
        placement="rightTop"
      >
        <Button
          size="small"
          type="text"
          block
          onClick={() => {
            track("action-bar", { action: "hide" });
            actions?.toggleActionButtons();
          }}
          style={{
            marginBottom: TOGGLE_ACTIVITY_BAR_TOGGLE_BUTTON_SPACE,
            background: workspaceChrome?.activityBarBackground,
          }}
        >
          <Icon name="vertical-right-outlined" />
        </Button>
      </Tooltip>
    );
  }

  return (
    <div
      ref={parent}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        paddingTop: workspaceChrome ? "0.25px" : undefined,
        // this gives users on small screens a chance  to get to the bottom of the tabs.
        // also, the scrollbar is intentionally only active in condensed mode, to avoid it to show up briefly.
        overflowY: condensed ? "auto" : "hidden",
        overflowX: "hidden",
        flex: "1 1 0",
      }}
    >
      {items}
      {renderOverflowMenu()}
      {/* moves the layout selector to the bottom */}
      <div ref={gap} style={{ flex: 1 }}></div>
      {/* moves hide switch to the bottom */}
      <LayoutSelector
        workspaceChrome={workspaceChrome}
        onCustomize={() => setShowCustomize(true)}
      />
      {renderToggleActivityBar()}
      <CustomizeRailButtonsModal
        hiddenTabs={hiddenTabs}
        open={showCustomize}
        onClose={() => setShowCustomize(false)}
        onSave={(nextOrder, nextHidden) => {
          account_settings.set_other_settings(
            ACTIVITY_BAR_TAB_ORDER,
            nextOrder,
          );
          account_settings.set_other_settings(
            ACTIVITY_BAR_HIDDEN_TABS,
            nextHidden,
          );
          setShowCustomize(false);
        }}
        order={tabOrder}
      />
    </div>
  );
}

type LayoutSelectorProps = {
  workspaceChrome: WorkspaceStrongThemeChrome | null;
  onCustomize: () => void;
};

function LayoutSelector({
  workspaceChrome,
  onCustomize,
}: Readonly<LayoutSelectorProps>) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const { showActBarLabels } = useAppContext();
  const account_settings = useActions("account");
  const items: NonNullable<MenuProps["items"]> = [];

  items.push({
    key: "toggle-labels",
    label: (
      <span>
        <Icon name={"signature-outlined"} />{" "}
        {intl.formatMessage(ACTIVITY_BAR_TOGGLE_LABELS, {
          show: showActBarLabels,
        })}
      </span>
    ),
    onClick: () => {
      account_settings.set_other_settings(
        ACTIVITY_BAR_LABELS,
        !showActBarLabels,
      );
    },
  });
  items.push({ key: "divider-1", type: "divider" });
  items.push({
    key: "customize",
    label: (
      <span>
        <Icon name="sliders" /> Customize buttons
      </span>
    ),
    onClick: onCustomize,
  });

  return (
    <div style={{ textAlign: "center" }}>
      <Dropdown
        menu={{ items }}
        trigger={["click"]}
        onOpenChange={(next) => setOpen(next)}
        placement="topLeft"
      >
        <Button
          icon={<Icon name="layout" />}
          block
          style={{
            ...(workspaceChrome
              ? {
                  background: workspaceChrome.activityBarBackground,
                  boxShadow: `inset 0 -2px 0 ${workspaceChrome.activityBarBorder}`,
                }
              : undefined),
            ...(open
              ? workspaceChrome
                ? {
                    boxShadow: `inset 0 -2px 0 ${workspaceChrome.activityBarBorder}, inset 0 0 0 1px ${workspaceChrome.activityBarBorder}`,
                  }
                : { backgroundColor: COLORS.GRAY_LL }
              : undefined),
          }}
          type="text"
        />
      </Dropdown>
    </div>
  );
}

function renderFixedTabLabel(name: FixedTab, intl): ReactNode {
  const label = FIXED_PROJECT_TABS[name].label;
  return typeof label === "string" ? label : intl.formatMessage(label as any);
}

interface CustomizeRailButtonsModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (order: FixedTab[], hidden: FixedTab[]) => void;
  order: FixedTab[];
  hiddenTabs: FixedTab[];
}

function CustomizeRailButtonsModal({
  open,
  onClose,
  onSave,
  order,
  hiddenTabs,
}: Readonly<CustomizeRailButtonsModalProps>) {
  const intl = useIntl();
  const [draftOrder, setDraftOrder] = useState<FixedTab[]>(order);
  const [draftHidden, setDraftHidden] = useState<FixedTab[]>(hiddenTabs);
  const hiddenSet = useMemo(() => new Set(draftHidden), [draftHidden]);

  useEffect(() => {
    if (!open) return;
    setDraftOrder(order);
    setDraftHidden(hiddenTabs);
  }, [hiddenTabs, open, order]);

  function setTabVisible(name: FixedTab, nextVisible: boolean): void {
    if (nextVisible) {
      setDraftHidden((current) => current.filter((item) => item !== name));
      return;
    }
    const visibleCount = draftOrder.filter(
      (item) => !hiddenSet.has(item),
    ).length;
    if (visibleCount <= 1) return;
    setDraftHidden((current) =>
      current.includes(name) ? current : [...current, name],
    );
  }

  const defaultsOrder = getDefaultFixedTabOrder({ liteMode: lite });
  const defaultsHidden = getDefaultHiddenFixedTabs({ liteMode: lite });

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="Customize left rail"
      width={520}
      okText="Save"
      onOk={() => onSave(draftOrder, draftHidden)}
      footer={[
        <Button
          key="reset"
          onClick={() => {
            setDraftOrder(defaultsOrder);
            setDraftHidden(defaultsHidden);
          }}
        >
          Reset defaults
        </Button>,
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        <Button
          key="save"
          type="primary"
          onClick={() => onSave(draftOrder, draftHidden)}
        >
          Save
        </Button>,
      ]}
    >
      <p style={{ color: COLORS.GRAY }}>
        Drag to reorder buttons. Uncheck a button to move it into the More menu.
        These preferences are stored per user.
      </p>
      <SortableList
        items={draftOrder}
        onDragStop={(oldIndex, newIndex) =>
          setDraftOrder((current) => moveFixedTab(current, oldIndex, newIndex))
        }
      >
        {draftOrder.map((name) => {
          const visible = !hiddenSet.has(name);
          return (
            <SortableItem key={name} id={name}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "8px 0",
                  opacity: visible ? 1 : 0.6,
                  borderBottom: `1px solid ${COLORS.GRAY_LLL}`,
                }}
              >
                <Checkbox
                  checked={visible}
                  onChange={(e) => setTabVisible(name, e.target.checked)}
                />
                <Icon name={FIXED_PROJECT_TABS[name].icon} />
                <div style={{ flex: 1 }}>
                  {renderFixedTabLabel(name, intl)}
                  <div
                    style={{
                      color: COLORS.GRAY,
                      fontSize: "12px",
                      marginTop: "2px",
                    }}
                  >
                    {visible ? "Pinned to rail" : "Shown in More"}
                  </div>
                </div>
                <DragHandle id={name} />
              </div>
            </SortableItem>
          );
        })}
      </SortableList>
    </Modal>
  );
}

function ChatIndicatorTab({ activeTab, project_id }): React.JSX.Element | null {
  const openFileInfo = useTypedRedux({ project_id }, "open_files");
  if (!activeTab?.startsWith("editor-")) {
    // TODO: This is the place in the code where we could support project-wide
    // side chat, or side chats for each individual Files/Search, etc. page.
    return null;
  }
  const path = tab_to_path(activeTab);
  if (path == null) {
    // bug -- tab is not a file tab.
    return null;
  }
  const chatState = openFileInfo.getIn([path, "chatState"]) as any;
  return (
    <div style={INDICATOR_STYLE}>
      <ChatIndicator
        project_id={project_id}
        path={path}
        chatState={chatState}
      />
    </div>
  );
}

function ShareIndicatorTab({ activeTab, project_id }) {
  const currentPathAbs = useTypedRedux({ project_id }, "current_path_abs");
  const currentPath = currentPathAbs ?? "/";

  const path = activeTab === "files" ? currentPath : tab_to_path(activeTab);
  if (path == null) {
    // nothing specifically to share
    return null;
  }
  if (path === "/") {
    // sharing whole project not implemented
    return null;
  }
  return (
    <div style={INDICATOR_STYLE}>
      <ShareIndicator project_id={project_id} path={path} />
    </div>
  );
}
