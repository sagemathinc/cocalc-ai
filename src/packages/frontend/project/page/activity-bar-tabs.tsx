/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Tabs in a particular project.
*/

import type { MenuProps } from "antd";
import { Button, Checkbox, Dropdown, Modal } from "antd";
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
import { CSS, useTypedRedux } from "@cocalc/frontend/app-framework";
import { useAccountStoreReady } from "@cocalc/frontend/app/account-store-ready";
import useAppContext from "@cocalc/frontend/app/use-context";
import { ChatIndicator } from "@cocalc/frontend/chat/chat-indicator";
import {
  Icon,
  isIconName,
  Tooltip,
  type IconName,
} from "@cocalc/frontend/components";
import {
  DragHandle,
  SortableItem,
  SortableList,
} from "@cocalc/frontend/components/sortable-list";
import { labels } from "@cocalc/frontend/i18n";
import { useProjectContext } from "@cocalc/frontend/project/context";
import { confirmRemoveMyselfFromProject } from "@cocalc/frontend/projects/remove-myself";

import { tab_to_path } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { ACTIVITY_BAR_TOGGLE_LABELS } from "./activity-bar-consts";
import { FileTab, FIXED_PROJECT_TABS, FixedTab } from "./file-tab";
import FileTabs from "./file-tabs";
import { lite } from "@cocalc/frontend/lite";
import SettingsButton from "@cocalc/frontend/account/settings-button";
import { RemoteSshButton, SshButton } from "@cocalc/frontend/ssh";
import SshUpgradeButton from "@cocalc/frontend/ssh/ssh-upgrade-button";
import { workspaceStrongThemeChrome } from "../workspaces/strong-theme";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import {
  getDefaultFixedTabOrder,
  getDefaultHiddenFixedTabs,
  moveFixedTab,
  splitRailTabs,
} from "./activity-bar-preferences";
import {
  setActivityBarCollapsed,
  setActivityBarHiddenTabs,
  setActivityBarLabels,
  setActivityBarTabOrder,
  useActivityBarPreferences,
} from "./activity-bar-storage";
import { hasModifierKey } from "./utils";

const INDICATOR_STYLE: React.CSSProperties = {
  overflow: "hidden",
  paddingLeft: "5px",
} as const;

export const FIXED_TABS_BG_COLOR = "rgba(0, 0, 0, 0.02)";
const VIEWER_FIXED_TABS = new Set<FixedTab>([
  "active",
  "docs",
  "files",
  "users",
]);

interface ThemedFixedTab {
  color?: string;
  iconName?: IconName;
}

function useRootfsFixedTabTheme(enabled = true): ThemedFixedTab {
  const { project } = useProjectContext();
  const rootfsImageId = enabled
    ? `${project?.get?.("rootfs_image_id") ?? ""}`.trim()
    : "";
  const { images } = useRootfsImages(
    rootfsImageId ? [managedRootfsCatalogUrl()] : [],
    {
      imageIds: rootfsImageId ? [rootfsImageId] : [],
      limit: 1,
    },
  );
  const entry = rootfsImageId
    ? images.find((candidate) => candidate.id === rootfsImageId)
    : undefined;
  const iconName = isIconName(entry?.theme?.icon)
    ? entry.theme.icon
    : undefined;
  const color = entry?.theme?.color?.trim() || undefined;
  return { color, iconName };
}

function filterTabsForProjectAccess({
  agentAIEnabled,
  names,
  viewer,
}: {
  agentAIEnabled: boolean;
  names: readonly FixedTab[];
  viewer: boolean;
}): FixedTab[] {
  return names.filter((name) => {
    if (!agentAIEnabled && name === "agents") return false;
    if (viewer && !VIEWER_FIXED_TABS.has(name)) return false;
    return true;
  });
}

function preserveUnavailableTabs(opts: {
  agentAIEnabled: boolean;
  hiddenTabs: readonly FixedTab[];
  nextHidden: FixedTab[];
  nextOrder: FixedTab[];
  originalOrder: readonly FixedTab[];
  viewer: boolean;
}): { hidden: FixedTab[]; order: FixedTab[] } {
  const available = new Set(
    filterTabsForProjectAccess({
      agentAIEnabled: opts.agentAIEnabled,
      names: opts.originalOrder,
      viewer: opts.viewer,
    }),
  );
  const unavailableOrder = opts.originalOrder.filter(
    (name) => !available.has(name),
  );
  const unavailableHidden = opts.hiddenTabs.filter(
    (name) => !available.has(name),
  );
  return {
    order: [
      ...opts.nextOrder,
      ...unavailableOrder.filter((name) => !opts.nextOrder.includes(name)),
    ],
    hidden: [
      ...opts.nextHidden,
      ...unavailableHidden.filter((name) => !opts.nextHidden.includes(name)),
    ],
  };
}

interface PTProps {
  project_id: string;
}

export default function ProjectTabs(props: PTProps) {
  const { project_id } = props;
  const { projectAccess } = useProjectContext();
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
        {projectAccess?.role !== "viewer" && (
          <div
            style={{
              display: "inline-flex",
              marginLeft: "-10px",
            }}
          >
            <ChatIndicatorTab activeTab={activeTab} project_id={project_id} />
          </div>
        )}
        {lite && projectAccess?.role !== "viewer" && (
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
    agentAIEnabled,
    project_id,
    active_project_tab: activeTab,
    projectAccess,
    workspaces,
  } = useProjectContext();
  const accountStoreReady = useAccountStoreReady();
  const { showActBarLabels } = useAppContext();
  const account_id = useTypedRedux("account", "account_id");
  const active_flyout = useTypedRedux({ project_id }, "flyout");
  const viewer = projectAccess?.role === "viewer";
  const rootfsTheme = useRootfsFixedTabTheme(!viewer);
  const parent = useRef<HTMLDivElement>(null);
  const gap = useRef<HTMLDivElement>(null);
  const breakPoint = useRef<number>(0);
  const refCondensed = useRef<boolean>(false);
  const [condensed, setCondensed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const workspaceChrome = workspaceStrongThemeChrome(workspaces.current);
  const { order: tabOrder, hidden: hiddenTabs } = useActivityBarPreferences({
    liteMode: lite,
  });
  const projectLabel = intl.formatMessage(labels.project);
  const { visible: pinnedTabs, overflow: overflowTabs } = useMemo(() => {
    const filteredOrder = filterTabsForProjectAccess({
      agentAIEnabled,
      names: tabOrder,
      viewer,
    });
    const filteredHidden = filterTabsForProjectAccess({
      agentAIEnabled,
      names: hiddenTabs,
      viewer,
    });
    return splitRailTabs(filteredOrder, filteredHidden);
  }, [agentAIEnabled, hiddenTabs, tabOrder, viewer]);

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
      name === "workspaces" && workspaces.current?.theme?.image_blob?.trim()
        ? `/blobs/theme-image.png?uuid=${encodeURIComponent(
            workspaces.current.theme.image_blob.trim(),
          )}`
        : undefined;
    const iconName: IconName | undefined =
      name === "workspaces"
        ? (workspaces.current?.theme?.icon?.trim() as IconName | undefined) ||
          undefined
        : name === "rootfs"
          ? rootfsTheme.iconName
          : undefined;
    const themedIconStyle =
      name === "workspaces" && workspaces.current?.theme?.color
        ? { color: workspaces.current.theme.color }
        : name === "rootfs" && rootfsTheme.color
          ? { color: rootfsTheme.color }
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

  function openOverflowTab(
    name: FixedTab,
    domEvent?: Pick<MouseEvent, "ctrlKey" | "shiftKey" | "metaKey"> | null,
  ): void {
    openRailMenuTab({
      actions,
      domEvent,
      name,
      project_id,
      source: "overflow",
    });
  }

  function renderOverflowMenu(): ReactNode {
    if (!accountStoreReady || overflowTabs.length === 0) return null;
    const isActive =
      moreOpen ||
      (active_flyout != null && overflowTabs.includes(active_flyout));
    const items = createRailMenuItems({
      intl,
      names: overflowTabs,
      onCustomize: () => setShowCustomize(true),
      onToggleActivityBar: () => {
        setActivityBarCollapsed(true);
      },
      onToggleLabels: () => {
        setActivityBarLabels(!showActBarLabels);
      },
      onTabClick: openOverflowTab,
      railToggleLabel: "Hide activity bar",
      railToggleIcon: "vertical-right-outlined",
      removeSelf:
        viewer && project_id != null
          ? {
              onClick: () => {
                setMoreOpen(false);
                confirmRemoveMyselfFromProject({
                  project_id,
                  account_id,
                  projectLabel,
                  projectLabelLower: projectLabel.toLowerCase(),
                });
              },
            }
          : undefined,
      requestCollaboratorAccess:
        viewer && project_id != null
          ? {
              onClick: () => {
                setMoreOpen(false);
                void requestViewerCollaboratorAccess(project_id);
              },
            }
          : undefined,
      sectionKeyPrefix: "overflow",
      showActBarLabels: showActBarLabels === true,
      tabIcons: {
        rootfs: rootfsTheme.iconName,
      },
    });
    return (
      <Tooltip title="More" placement="rightTop">
        <div
          style={{
            width: "100%",
            boxSizing: "border-box",
            paddingLeft: "8px",
            paddingRight: "8px",
            paddingTop: showActBarLabels ? "8px" : "2px",
            paddingBottom: "2px",
          }}
        >
          <Dropdown
            menu={{ items }}
            trigger={["click"]}
            placement="topLeft"
            transitionName=""
            onOpenChange={(next) => setMoreOpen(next)}
          >
            <button
              type="button"
              style={{
                display: "block",
                width: "100%",
                margin: 0,
                padding: 0,
                cursor: "pointer",
                borderTop: 0,
                borderRight: 0,
                borderBottom: 0,
                borderLeft: `4px solid ${
                  isActive ? COLORS.PROJECT.FIXED_LEFT_ACTIVE : "transparent"
                }`,
                borderRadius: 0,
                outline: "none",
                background: isActive
                  ? COLORS.BLUE_LLLL
                  : workspaceChrome?.activityBarBackground,
                color: isActive ? COLORS.PROJECT.FIXED_LEFT_ACTIVE : undefined,
                textAlign: "inherit",
                font: "inherit",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: showActBarLabels ? "column" : undefined,
                  alignItems: "center",
                  justifyContent: "center",
                  gap: showActBarLabels ? "4px" : undefined,
                  minHeight: condensed ? "36px" : "40px",
                  width: "100%",
                }}
              >
                <Icon
                  name="ellipsis"
                  rotate="90"
                  style={{ fontSize: condensed ? "18px" : "24px" }}
                />
                {showActBarLabels ? <span>More</span> : null}
              </div>
            </button>
          </Dropdown>
        </div>
      </Tooltip>
    );
  }

  if (!accountStoreReady) {
    return (
      <div
        ref={parent}
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          flex: "1 1 0",
        }}
      />
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
      <div ref={gap} style={{ flex: 1 }}></div>
      <CustomizeRailButtonsModal
        hiddenTabs={hiddenTabs}
        open={showCustomize}
        onClose={() => setShowCustomize(false)}
        onSave={(nextOrder, nextHidden) => {
          const preserved = preserveUnavailableTabs({
            agentAIEnabled,
            hiddenTabs,
            nextHidden,
            nextOrder,
            originalOrder: tabOrder,
            viewer,
          });
          setActivityBarTabOrder(preserved.order, { liteMode: lite });
          setActivityBarHiddenTabs(preserved.hidden, { liteMode: lite });
          setShowCustomize(false);
        }}
        order={filterTabsForProjectAccess({
          agentAIEnabled,
          names: tabOrder,
          viewer,
        })}
      />
    </div>
  );
}

export function HiddenActivityBarLauncher() {
  const intl = useIntl();
  const { actions, agentAIEnabled, project_id, projectAccess } =
    useProjectContext();
  const accountStoreReady = useAccountStoreReady();
  const { showActBarLabels } = useAppContext();
  const account_id = useTypedRedux("account", "account_id");
  const viewer = projectAccess?.role === "viewer";
  const rootfsTheme = useRootfsFixedTabTheme(!viewer);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const { order: tabOrder, hidden: hiddenTabs } = useActivityBarPreferences({
    liteMode: lite,
  });
  if (!accountStoreReady) return null;

  const projectLabel = intl.formatMessage(labels.project);
  const items = createRailMenuItems({
    intl,
    names: filterTabsForProjectAccess({
      agentAIEnabled,
      names: tabOrder,
      viewer,
    }),
    onCustomize: () => setShowCustomize(true),
    onToggleActivityBar: () => {
      setActivityBarCollapsed(false);
    },
    onToggleLabels: () => {
      setActivityBarLabels(!showActBarLabels);
    },
    onTabClick: (name, domEvent) => {
      openRailMenuTab({
        actions,
        domEvent,
        name,
        project_id,
        source: "hidden-launcher",
      });
    },
    railToggleLabel: "Show activity bar",
    railToggleIcon: "vertical-left-outlined",
    removeSelf:
      viewer && project_id != null
        ? {
            onClick: () => {
              setMenuOpen(false);
              confirmRemoveMyselfFromProject({
                project_id,
                account_id,
                projectLabel,
                projectLabelLower: projectLabel.toLowerCase(),
              });
            },
          }
        : undefined,
    requestCollaboratorAccess:
      viewer && project_id != null
        ? {
            onClick: () => {
              setMenuOpen(false);
              void requestViewerCollaboratorAccess(project_id);
            },
          }
        : undefined,
    sectionKeyPrefix: "launcher",
    showActBarLabels: showActBarLabels === true,
    tabIcons: {
      rootfs: rootfsTheme.iconName,
    },
  });

  return (
    <>
      <Dropdown
        menu={{ items }}
        trigger={["click"]}
        placement="bottomLeft"
        transitionName=""
        onOpenChange={(next) => setMenuOpen(next)}
      >
        <Button
          data-testid="hidden-rail-launcher"
          size="large"
          type="text"
          style={{
            width: "40px",
            border: "none",
            borderRadius: "0",
            fontSize: "22px",
            color: menuOpen ? COLORS.ANTD_LINK_BLUE : COLORS.FILE_ICON,
            transitionDuration: "0s",
            background: "#fafafa",
          }}
        >
          <Icon name="bars" style={{ verticalAlign: "4px" }} />
        </Button>
      </Dropdown>
      <CustomizeRailButtonsModal
        hiddenTabs={hiddenTabs}
        open={showCustomize}
        onClose={() => setShowCustomize(false)}
        onSave={(nextOrder, nextHidden) => {
          const preserved = preserveUnavailableTabs({
            agentAIEnabled,
            hiddenTabs,
            nextHidden,
            nextOrder,
            originalOrder: tabOrder,
            viewer,
          });
          setActivityBarTabOrder(preserved.order, { liteMode: lite });
          setActivityBarHiddenTabs(preserved.hidden, { liteMode: lite });
          setShowCustomize(false);
        }}
        order={filterTabsForProjectAccess({
          agentAIEnabled,
          names: tabOrder,
          viewer,
        })}
      />
    </>
  );
}

function openRailMenuTab(opts: {
  actions: any;
  domEvent?: Pick<MouseEvent, "ctrlKey" | "shiftKey" | "metaKey"> | null;
  name: FixedTab;
  project_id: string;
  source: "overflow" | "hidden-launcher";
}): void {
  const { actions, domEvent, name } = opts;
  const canOpenFullPage = !FIXED_PROJECT_TABS[name].noFullPage;
  if (canOpenFullPage && hasModifierKey(domEvent)) {
    actions?.set_active_tab(name);

    return;
  }
  actions?.toggleFlyout(name);
}

function createRailMenuItems(opts: {
  intl: ReturnType<typeof useIntl>;
  names: FixedTab[];
  onCustomize: () => void;
  onToggleActivityBar: () => void;
  onToggleLabels: () => void;
  onTabClick: (
    name: FixedTab,
    domEvent?: Pick<MouseEvent, "ctrlKey" | "shiftKey" | "metaKey"> | null,
  ) => void;
  railToggleLabel: string;
  railToggleIcon: IconName;
  removeSelf?: {
    onClick: () => void;
  };
  requestCollaboratorAccess?: {
    onClick: () => void;
  };
  sectionKeyPrefix: string;
  showActBarLabels: boolean;
  tabIcons?: Partial<Record<FixedTab, IconName | undefined>>;
}): NonNullable<MenuProps["items"]> {
  const {
    intl,
    names,
    onCustomize,
    onToggleActivityBar,
    onToggleLabels,
    onTabClick,
    railToggleLabel,
    railToggleIcon,
    removeSelf,
    requestCollaboratorAccess,
    sectionKeyPrefix,
    showActBarLabels,
    tabIcons,
  } = opts;
  const items: NonNullable<MenuProps["items"]> = names.map((name) => ({
    key: `${sectionKeyPrefix}:${name}`,
    label: renderMenuLabel(
      <Icon name={tabIcons?.[name] ?? FIXED_PROJECT_TABS[name].icon} />,
      renderFixedTabLabel(name, intl),
    ),
    onClick: ({ domEvent }) => onTabClick(name, domEvent),
  }));
  if (names.length > 0) {
    items.push({ key: `divider-${sectionKeyPrefix}`, type: "divider" });
  }
  if (removeSelf != null || requestCollaboratorAccess != null) {
    const children: NonNullable<MenuProps["items"]> = [];
    if (requestCollaboratorAccess != null) {
      children.push({
        key: `${sectionKeyPrefix}:request-collaborator-access`,
        label: renderMenuLabel(
          <Icon name="user-plus" />,
          "Request Collaborator Access",
        ),
        onClick: requestCollaboratorAccess.onClick,
      });
    }
    if (removeSelf != null) {
      children.push({
        key: `${sectionKeyPrefix}:remove-self`,
        label: renderMenuLabel(
          <Icon name="user-times" />,
          "Remove Myself as Collaborator",
        ),
        danger: true,
        onClick: removeSelf.onClick,
      });
    }
    items.push({
      key: `${sectionKeyPrefix}-project-access`,
      type: "group",
      label: "Project access",
      children,
    });
    items.push({
      key: `divider-${sectionKeyPrefix}-project-access`,
      type: "divider",
    });
  }
  items.push({
    key: `${sectionKeyPrefix}-rail-controls`,
    type: "group",
    label: "Rail",
    children: [
      {
        key: `${sectionKeyPrefix}:customize`,
        label: renderMenuLabel(<Icon name="sliders" />, "Customize buttons"),
        onClick: onCustomize,
      },
      {
        key: `${sectionKeyPrefix}:toggle-labels`,
        label: renderMenuLabel(
          <Icon name="signature-outlined" />,
          intl.formatMessage(ACTIVITY_BAR_TOGGLE_LABELS, {
            show: showActBarLabels,
          }),
        ),
        onClick: onToggleLabels,
      },
      {
        key: `${sectionKeyPrefix}:toggle-activity-bar`,
        label: renderMenuLabel(<Icon name={railToggleIcon} />, railToggleLabel),
        onClick: onToggleActivityBar,
      },
    ],
  });
  return items;
}

async function requestViewerCollaboratorAccess(project_id: string) {
  try {
    const { webapp_client } = await import("@cocalc/frontend/webapp-client");
    await webapp_client.project_collaborators.request_access({
      project_id,
      requested_role: "collaborator",
      source: "rail-menu",
    });
    Modal.success({
      title: "Collaborator access requested",
      content:
        "A project owner or authorized collaborator can approve your request.",
    });
  } catch (err) {
    Modal.error({
      title: "Unable to request collaborator access",
      content: `${err}`,
    });
  }
}

function renderFixedTabLabel(name: FixedTab, intl): ReactNode {
  const label = FIXED_PROJECT_TABS[name].label;
  return typeof label === "string" ? label : intl.formatMessage(label as any);
}

function renderMenuLabel(icon: ReactNode, label: ReactNode): ReactNode {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "15px" }}>
      {icon}
      <span>{label}</span>
    </span>
  );
}

interface CustomizeRailButtonsModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (order: FixedTab[], hidden: FixedTab[]) => void;
  order: FixedTab[];
  hiddenTabs: FixedTab[];
}

export function CustomizeRailButtonsModal({
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
  const wasOpenRef = useRef(open);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open || wasOpen) return;
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
        Check a button to show it on the left rail. Drag to reorder buttons.
        These preferences are stored in this browser only.
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
            <SortableItem key={name} id={name} hideActive={false}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "8px 0",
                  borderBottom: `1px solid ${COLORS.GRAY_LLL}`,
                }}
              >
                <Checkbox
                  checked={visible}
                  onChange={(e) => setTabVisible(name, e.target.checked)}
                />
                <Icon name={FIXED_PROJECT_TABS[name].icon} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {renderFixedTabLabel(name, intl)}
                </div>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    borderRadius: "999px",
                    padding: "1px 8px",
                    fontSize: "11px",
                    fontWeight: 600,
                    letterSpacing: "0.01em",
                    background: visible ? COLORS.BS_GREEN_LL : COLORS.BLUE_LLLL,
                    color: visible
                      ? COLORS.ANTD_GREEN_D
                      : COLORS.ANTD_LINK_BLUE_DARK,
                    marginRight: "4px",
                  }}
                >
                  {visible ? "Rail" : "More"}
                </span>
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
