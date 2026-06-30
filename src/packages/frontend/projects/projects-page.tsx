/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Grid, Layout, Row } from "antd";
import { Map, Set as ImmutableSet } from "immutable";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { useIntl } from "react-intl";

// ensure redux stuff (actions and store) are initialized:
import "./actions";
import { IS_MOBILE } from "@cocalc/frontend/feature";

import {
  CSS,
  React,
  redux,
  useEffect,
  useMemo,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon, Loading, LoginLink, Title } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { COLORS } from "@cocalc/util/theme";
import {
  IncomingInviteBanner,
  useInviteInboxState,
} from "@cocalc/frontend/collaborators";
import { capitalize } from "@cocalc/util/misc";

import { NewProjectCreator } from "./create-project";
import { ProjectsOperations } from "./projects-operations";
import { StarredProjectsBar } from "./projects-starred";
import { ProjectsTable } from "./projects-table";
import { ProjectsTableControls } from "./projects-table-controls";
import { ProjectDrawer } from "./project-drawer";
import ProjectsPageTour from "./tour";
import { getVisibleProjects } from "./util";
import { FilenameSearch } from "./filename-search";
import { MobileProjectsList } from "./mobile-projects-list";
import { RecentDocumentActivityButton } from "@cocalc/frontend/file-use/button";
import {
  useEmailVerificationRequired,
  VerifyEmailRequiredPanel,
} from "@cocalc/frontend/app/verify-email-banner";
import {
  retainScheduledProjectDeletes,
  useProjectDeleteQueue,
} from "./project-delete-queue";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { projectRootfsEntryLabel } from "./project-rootfs-badge";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { OTHER_SETTINGS_LEGACY_MIGRATION_PROJECTS_BUTTON } from "@cocalc/util/legacy-migration";

const LOADING_STYLE: CSS = {
  fontSize: "40px",
  textAlign: "center",
  color: COLORS.GRAY,
} as const;

const PROJECTS_TABLE_INITIAL_BODY_HEIGHT = 400;
const PROJECTS_TABLE_MIN_BODY_HEIGHT = 160;
const PROJECTS_TABLE_HEADER_RESERVED_PX = 48;

const VISIBLE_WINDOW_REPAIR_LIMIT = 200;
const VISIBLE_WINDOW_REPAIR_DELAY_MS = 500;

function useProjectTableBodyHeight(
  projectListRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
): number {
  const [height, setHeight] = useState(PROJECTS_TABLE_INITIAL_BODY_HEIGHT);

  useLayoutEffect(() => {
    if (!enabled) {
      return;
    }
    const element = projectListRef.current;
    if (element == null) {
      return;
    }

    const updateHeight = () => {
      const next = Math.max(
        Math.floor(
          element.getBoundingClientRect().height -
            PROJECTS_TABLE_HEADER_RESERVED_PX,
        ),
        PROJECTS_TABLE_MIN_BODY_HEIGHT,
      );
      setHeight((cur) => (cur === next ? cur : next));
    };

    updateHeight();

    if (globalThis.ResizeObserver == null) {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [enabled, projectListRef]);

  return height;
}

function readMaybeImmutable(value: any, key: string): any {
  return value?.get?.(key) ?? value?.[key];
}

function projectIdsFromMaybeImmutable(value: any): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value?.toArray === "function") return value.toArray();
  return [];
}

function projectListWindowQuery({
  hidden,
  search,
}: {
  hidden: boolean;
  search: string;
}) {
  return {
    limit: VISIBLE_WINDOW_REPAIR_LIMIT,
    offset: 0,
    hidden,
    search: `${search ?? ""}`.trim(),
    sort: "last_edited" as const,
  };
}

export const ProjectsPage: React.FC = () => {
  const intl = useIntl();

  const project_map = useTypedRedux("projects", "project_map");
  const host_info = useTypedRedux("projects", "host_info");
  const user_map = useTypedRedux("users", "user_map");
  const activeTopTab = useTypedRedux("page", "active_top_tab");
  const otherSettings = useTypedRedux("account", "other_settings");
  const legacyMigrationEnabled = !!useTypedRedux(
    "customize",
    "legacy_migration_enabled",
  );
  const showLegacyProjectsButton =
    legacyMigrationEnabled &&
    !!otherSettings?.get(OTHER_SETTINGS_LEGACY_MIGRATION_PROJECTS_BUTTON);
  const projectRootfsImageIds = useMemo(() => {
    const ids = new globalThis.Set<string>();
    project_map?.forEach((project) => {
      const id = `${project?.get?.("rootfs_image_id") ?? ""}`.trim();
      if (id) {
        ids.add(id);
      }
    });
    return Array.from(ids).sort();
  }, [project_map]);
  const { images: rootfsImages, loading: rootfsImagesLoading } =
    useRootfsImages([managedRootfsCatalogUrl()], {
      imageIds: projectRootfsImageIds,
      limit: 200,
    });
  const rootfsLabelById = useMemo(() => {
    const labelMap = new globalThis.Map<string, string>();
    for (const entry of rootfsImages) {
      if (entry.id) {
        labelMap.set(entry.id, projectRootfsEntryLabel({ entry }));
      }
    }
    return labelMap;
  }, [rootfsImages]);

  const all_projects: string[] = useMemo(
    () => project_map?.keySeq().toJS() ?? [],
    [project_map?.size],
  );

  const screens = Grid.useBreakpoint();
  const mobileProjectsList = IS_MOBILE && !screens.lg;
  const narrow = mobileProjectsList;

  // Tour
  const searchRef = useRef<any>(null);
  const filtersRef = useRef<any>(null);
  const createNewRef = useRef<any>(null);
  const projectListRef = useRef<HTMLDivElement>(null);
  const filenameSearchRef = useRef<any>(null);

  const [createPanelOpen, setCreatePanelOpen] = useState(false);

  const tableHeight = useProjectTableBodyHeight(
    projectListRef,
    !mobileProjectsList,
  );
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const { scheduledDeleteProjectIds } = useProjectDeleteQueue();

  // Track filtered collaborators from table
  const [filteredCollaborators, setFilteredCollaborators] = useState<
    string[] | null
  >(null);

  // status of filters
  const hidden = !!useTypedRedux("projects", "hidden");
  const filter = useMemo(() => {
    return `${!!hidden}`;
  }, [hidden]);
  const search: string = useTypedRedux("projects", "search");
  const inviteState = useInviteInboxState({
    includeOutgoing: false,
    includeBlocks: false,
  });
  const emailVerificationRequired = useEmailVerificationRequired();
  const createProjectDisabled = emailVerificationRequired;

  const selected_hashtags: Map<string, ImmutableSet<string>> = useTypedRedux(
    "projects",
    "selected_hashtags",
  );
  const project_list_window = useTypedRedux("projects", "project_list_window");

  function openInvitations() {
    redux.getActions("mentions").set_filter("unread");
    redux.getActions("page").set_active_tab("notifications");
  }

  const local_visible_projects: string[] = useMemo(() => {
    return getVisibleProjects(
      project_map,
      host_info,
      user_map,
      selected_hashtags?.get(filter),
      search,
      hidden,
      "last_edited" /* "user_last_active" was confusing */,
      rootfsLabelById,
    );
  }, [
    project_map,
    host_info,
    user_map,
    hidden,
    filter,
    selected_hashtags,
    search,
    rootfsLabelById,
  ]);

  const activeHashtags = selected_hashtags?.get(filter);
  const backendWindowQuery = useMemo(
    () => projectListWindowQuery({ hidden, search }),
    [hidden, search],
  );
  const backendWindowKey = useMemo(
    () => JSON.stringify(backendWindowQuery),
    [backendWindowQuery],
  );

  const backend_visible_projects: string[] | undefined = useMemo(() => {
    if ((activeHashtags?.size ?? 0) > 0) {
      return undefined;
    }
    if (readMaybeImmutable(project_list_window, "key") !== backendWindowKey) {
      return undefined;
    }
    const dirty = !!readMaybeImmutable(project_list_window, "dirty");
    if (
      !dirty &&
      (readMaybeImmutable(project_list_window, "loading") ||
        readMaybeImmutable(project_list_window, "error"))
    ) {
      return undefined;
    }
    return projectIdsFromMaybeImmutable(
      readMaybeImmutable(project_list_window, "project_ids"),
    );
  }, [activeHashtags, backendWindowKey, project_list_window]);

  const visible_projects = backend_visible_projects ?? local_visible_projects;
  const showingBackendWindow = backend_visible_projects != null;
  const backendWindowDirty =
    showingBackendWindow && !!readMaybeImmutable(project_list_window, "dirty");
  const backendWindowDirtyCount = Number(
    readMaybeImmutable(project_list_window, "dirty_count") ?? 0,
  );
  const refreshBackendWindow = React.useCallback(() => {
    void redux
      .getActions("projects")
      ?.loadProjectListWindowForCurrentAccount?.({
        ...backendWindowQuery,
        force: true,
      });
  }, [backendWindowQuery]);

  const visibleProjectionRepairKey = useMemo(
    () => visible_projects.slice(0, VISIBLE_WINDOW_REPAIR_LIMIT).join("\n"),
    [visible_projects],
  );

  const previousActiveTopTabRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const wasProjectsPage = previousActiveTopTabRef.current === "projects";
    const isProjectsPage = activeTopTab === "projects";
    previousActiveTopTabRef.current = activeTopTab;
    if (backendWindowDirty && isProjectsPage && !wasProjectsPage) {
      refreshBackendWindow();
    }
  }, [activeTopTab, backendWindowDirty, refreshBackendWindow]);

  useEffect(() => {
    const project_ids =
      visibleProjectionRepairKey.length === 0
        ? []
        : visibleProjectionRepairKey.split("\n");
    const actions = redux.getActions("projects");
    actions?.setVisibleProjectWindowForRepair?.(project_ids);
    return () => {
      actions?.setVisibleProjectWindowForRepair?.([]);
    };
  }, [visibleProjectionRepairKey]);

  useEffect(() => {
    if (visibleProjectionRepairKey.length === 0) {
      return;
    }
    const project_ids = visibleProjectionRepairKey.split("\n");
    const timer = setTimeout(() => {
      void redux.getActions("projects")?.repairProjectProjection?.({
        kind: "visible-window",
        project_ids,
        reason: "visible-window",
      });
    }, VISIBLE_WINDOW_REPAIR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [visibleProjectionRepairKey]);

  useEffect(() => {
    if (backendWindowDirty) {
      return;
    }
    const currentWindowKey = readMaybeImmutable(project_list_window, "key");
    if (
      currentWindowKey === backendWindowKey &&
      (readMaybeImmutable(project_list_window, "loading") ||
        readMaybeImmutable(project_list_window, "loaded_at"))
    ) {
      return;
    }
    const timer = setTimeout(() => {
      // This backend window is a convergence aid: it refreshes the same top
      // slice the user is likely looking at without replacing the richer local
      // search/filter semantics used for rendering.
      void redux
        .getActions("projects")
        ?.loadProjectListWindowForCurrentAccount?.(backendWindowQuery);
    }, VISIBLE_WINDOW_REPAIR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [
    backendWindowDirty,
    backendWindowKey,
    backendWindowQuery,
    project_list_window,
  ]);

  useEffect(() => {
    const visible = new Set(visible_projects);
    const scheduled = new Set(scheduledDeleteProjectIds);
    setSelectedProjectIds((ids) =>
      ids.filter((id) => {
        const state = `${project_map?.getIn([id, "state", "state"]) ?? ""}`;
        return visible.has(id) && !scheduled.has(id) && state !== "deleting";
      }),
    );
  }, [project_map, visible_projects, scheduledDeleteProjectIds]);

  useEffect(() => {
    retainScheduledProjectDeletes(all_projects);
  }, [all_projects]);

  useEffect(() => {
    if (!project_map) return;
    const actions = redux.getActions("projects");
    if (!actions) return;
    const hostIds = new Set<string>();
    project_map.forEach((project) => {
      const hostId = project.get("host_id");
      if (hostId) hostIds.add(hostId);
    });
    hostIds.forEach((hostId) => {
      actions.ensure_host_info(hostId);
    });
  }, [project_map]);

  function handleCreateProject() {
    if (createProjectDisabled) return;
    setCreatePanelOpen(true);
  }

  function handleClearCollaboratorFilter() {
    setFilteredCollaborators(null);
  }

  if (project_map == null) {
    if (redux.getStore("account")?.get_user_type() === "public") {
      return <LoginLink />;
    } else {
      return (
        <div style={LOADING_STYLE}>
          <Loading />
        </div>
      );
    }
  }

  const contentCol = { span: 20, offset: 2 };

  return (
    <div className={"smc-vfill"} style={{ overflow: "hidden" }}>
      <Layout
        style={{
          background: "white",
          height: "100%",
          display: "flex",
          flexDirection: "row",
          minHeight: 0,
        }}
      >
        {!createProjectDisabled && (
          <NewProjectCreator
            default_value={search}
            open={createPanelOpen}
            onClose={() => setCreatePanelOpen(false)}
          />
        )}
        <Layout.Content
          style={{
            background: "white",
            padding: mobileProjectsList ? "8px 8px 0 8px" : "16px 0 0 15px",
            minHeight: 0,
            overflow: mobileProjectsList ? "auto" : "hidden",
            zIndex: 1,
          }}
        >
          <div
            className={"smc-vfill"}
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              overflowY: mobileProjectsList ? "auto" : "hidden",
            }}
          >
            {emailVerificationRequired ? (
              <VerifyEmailRequiredPanel
                title="Verify your email to create projects"
                description="You can accept project invites and open projects you already have access to. Please verify your email address before creating new projects or starting project runtimes."
                compact
                style={{ marginBottom: 12 }}
              />
            ) : null}
            <Row style={{ flex: "1 1 auto", minHeight: 0, width: "100%" }}>
              <Col
                sm={24}
                md={24}
                lg={contentCol}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                }}
              >
                <div
                  style={{
                    width: "100%",
                    display: "flex",
                    flex: "1 1 auto",
                    flexDirection: "column",
                    gap: 10,
                    minHeight: 0,
                    padding: narrow ? "0 10px 0 10px" : "0",
                  }}
                >
                  <div
                    style={{
                      marginTop: mobileProjectsList ? "8px" : "20px",
                      display: "flex",
                      width: "100%",
                      gap: "10px",
                      alignItems: "center",
                      flexWrap: mobileProjectsList ? "wrap" : "nowrap",
                      flex: "0 0 auto",
                    }}
                  >
                    <Title
                      level={3}
                      style={{
                        flex: "0 1 auto",
                        marginBottom: mobileProjectsList ? 0 : "15px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <Icon name="edit" /> {intl.formatMessage(labels.projects)}
                    </Title>
                    <Button
                      ref={createNewRef}
                      type="primary"
                      disabled={createProjectDisabled}
                      title={
                        createProjectDisabled
                          ? "Verify your email address before creating projects."
                          : undefined
                      }
                      onClick={handleCreateProject}
                      icon={<Icon name="plus-circle" />}
                    >
                      {capitalize(intl.formatMessage(labels.create))}
                    </Button>
                    {showLegacyProjectsButton ? (
                      <Button
                        icon={<Icon name="exchange" />}
                        onClick={() =>
                          openAccountSettings({ page: "legacy-migration" })
                        }
                        title="View projects available from legacy migration."
                      >
                        Legacy Projects
                      </Button>
                    ) : null}
                    <div
                      style={{
                        flex: mobileProjectsList ? "1 0 100%" : "1 1 auto",
                        minWidth: 0,
                      }}
                    >
                      <StarredProjectsBar />
                    </div>
                    {!narrow && (
                      <div
                        ref={filenameSearchRef}
                        style={{
                          flex: "0 1 auto",
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <FilenameSearch
                          style={{
                            width: IS_MOBILE ? "100px" : "200px",
                            display: "inline-block",
                          }}
                        />
                        <RecentDocumentActivityButton />
                      </div>
                    )}
                  </div>

                  {narrow && (
                    <div
                      ref={filenameSearchRef}
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: "8px",
                        flex: "0 0 auto",
                      }}
                    >
                      <RecentDocumentActivityButton />
                      <FilenameSearch
                        style={{
                          width: IS_MOBILE ? "100px" : "200px",
                          display: "inline-block",
                        }}
                      />
                    </div>
                  )}

                  <div
                    style={{
                      maxHeight: "50vh",
                      overflow: "auto",
                      flex: "0 0 auto",
                    }}
                  >
                    <IncomingInviteBanner
                      state={inviteState}
                      onReview={openInvitations}
                    />
                  </div>

                  {/* Table Controls (Search, Filters, Create Button) */}
                  <div style={{ flex: "0 0 auto" }}>
                    <ProjectsTableControls
                      visible_projects={visible_projects}
                      searchRef={searchRef}
                      filtersRef={filtersRef}
                      projectListChanged={backendWindowDirty}
                      projectListChangedCount={backendWindowDirtyCount}
                      onRefreshProjectList={refreshBackendWindow}
                      tour={
                        <ProjectsPageTour
                          searchRef={searchRef}
                          filtersRef={filtersRef}
                          createNewRef={createNewRef}
                          projectListRef={projectListRef}
                          filenameSearchRef={filenameSearchRef}
                          style={{ flex: 0 }}
                        />
                      }
                    />
                  </div>
                  {/* Bulk Operations (when filters active) */}
                  <div style={{ flex: "0 0 auto" }}>
                    <ProjectsOperations
                      visible_projects={visible_projects}
                      selected_project_ids={selectedProjectIds}
                      onSelectionChange={setSelectedProjectIds}
                      filteredCollaborators={filteredCollaborators}
                      onClearCollaboratorFilter={handleClearCollaboratorFilter}
                    />
                  </div>

                  <div
                    ref={projectListRef}
                    style={{
                      flex: mobileProjectsList ? "0 0 auto" : "1 1 auto",
                      minHeight: 0,
                      overflow: mobileProjectsList ? undefined : "hidden",
                    }}
                  >
                    {mobileProjectsList ? (
                      <MobileProjectsList
                        visible_projects={visible_projects}
                        rootfsImages={rootfsImages}
                        rootfsImagesLoading={rootfsImagesLoading}
                        selectedProjectIds={selectedProjectIds}
                        onSelectedProjectIdsChange={setSelectedProjectIds}
                      />
                    ) : (
                      <ProjectsTable
                        visible_projects={visible_projects}
                        rootfsImages={rootfsImages}
                        rootfsImagesLoading={rootfsImagesLoading}
                        height={tableHeight}
                        narrow={narrow}
                        filteredCollaborators={filteredCollaborators}
                        onFilteredCollaboratorsChange={setFilteredCollaborators}
                        selectedProjectIds={selectedProjectIds}
                        onSelectedProjectIdsChange={setSelectedProjectIds}
                        freezeOrder={backendWindowDirty}
                      />
                    )}
                  </div>
                </div>
              </Col>
            </Row>
          </div>
        </Layout.Content>
      </Layout>
      <ProjectDrawer />
    </div>
  );
};
