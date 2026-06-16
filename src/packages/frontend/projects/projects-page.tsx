/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Grid, Layout, Row, Space } from "antd";
import { Map, Set as ImmutableSet } from "immutable";
import { useLayoutEffect, useRef } from "react";
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
import { useBookmarkedProjects } from "./use-bookmarked-projects";
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

const LOADING_STYLE: CSS = {
  fontSize: "40px",
  textAlign: "center",
  color: COLORS.GRAY,
} as const;
const VISIBLE_WINDOW_REPAIR_LIMIT = 200;
const VISIBLE_WINDOW_REPAIR_DELAY_MS = 500;

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
  const { bookmarkedProjects } = useBookmarkedProjects();

  const project_map = useTypedRedux("projects", "project_map");
  const host_info = useTypedRedux("projects", "host_info");
  const user_map = useTypedRedux("users", "user_map");
  const activeTopTab = useTypedRedux("page", "active_top_tab");
  const { images: rootfsImages, loading: rootfsImagesLoading } =
    useRootfsImages([managedRootfsCatalogUrl()], { limit: 200 });
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
  const projectListRef = useRef<any>(null);
  const filenameSearchRef = useRef<any>(null);

  // Calculating table height
  const containerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const starredBarRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const inviteInboxRef = useRef<HTMLDivElement>(null);
  const operationsRef = useRef<HTMLDivElement>(null);
  // Elements to account for in height calculation (everything except projectList and footer)
  const refs = [
    titleRef,
    starredBarRef,
    inviteInboxRef,
    controlsRef,
    operationsRef,
  ] as const;

  const [createPanelOpen, setCreatePanelOpen] = useState(false);

  const [tableHeight, setTableHeight] = useState<number>(400);
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

  // Calculate dynamic table height following these steps:
  // 1. Get container's offset from viewport top
  // 2. Available area = viewport height - offset
  // 3. Table height = available area - fixed elements - gaps
  useLayoutEffect(() => {
    const calculateHeight = () => {
      if (!containerRef.current) return;

      // 1. Get container's offset from top of viewport
      const containerTop = containerRef.current.getBoundingClientRect().top;

      // 2. Calculate available area for the entire page
      const viewportHeight = window.innerHeight;
      const availableArea = viewportHeight - containerTop;

      // 3. Sum heights of all fixed elements (including margins)
      let fixedElementsHeight = 0;
      refs.forEach((ref) => {
        if (ref.current) {
          const rect = ref.current.getBoundingClientRect();
          const style = window.getComputedStyle(ref.current);
          const marginTop = parseFloat(style.marginTop) || 0;
          const marginBottom = parseFloat(style.marginBottom) || 0;
          const totalHeight = rect.height + marginTop + marginBottom;
          fixedElementsHeight += totalHeight;
        }
      });

      // 4. Account for margins on the projectListRef wrapper div
      let projectListMargins = 0;
      if (projectListRef.current) {
        const style = window.getComputedStyle(projectListRef.current);
        const marginTop = parseFloat(style.marginTop) || 0;
        const marginBottom = parseFloat(style.marginBottom) || 0;
        projectListMargins = marginTop + marginBottom;
      }

      // 5. Account for 10px gaps between visible elements from Space component
      const visibleGaps = refs.length * 10;

      // 6. Add buffer to ensure loadAll button is fully visible
      const buffer = 80;

      const calculatedHeight =
        availableArea -
        fixedElementsHeight -
        projectListMargins -
        visibleGaps -
        buffer;

      // enforce a minimum height
      const newHeight = Math.max(calculatedHeight, 400);

      setTableHeight(newHeight);
    };

    const rafId = requestAnimationFrame(() => {
      calculateHeight();
      setTimeout(calculateHeight, 100);
    });

    // Set up ResizeObserver to watch for changes
    const resizeObserver = new ResizeObserver(calculateHeight);

    // Observe the container
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    // Observe all fixed elements so we detect when they change/disappear
    refs.forEach((ref) => {
      if (ref.current) {
        resizeObserver.observe(ref.current);
      }
    });

    // Also listen to window resize
    window.addEventListener("resize", calculateHeight);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      window.removeEventListener("resize", calculateHeight);
    };
  }, [bookmarkedProjects.length]);

  function handleCreateProject() {
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
        {!emailVerificationRequired && (
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
            overflow: "auto",
            zIndex: 1,
          }}
        >
          <div
            ref={containerRef}
            className={"smc-vfill"}
            style={{ overflowY: "auto" }}
          >
            {emailVerificationRequired ? (
              <VerifyEmailRequiredPanel
                title="Verify your email to use projects"
                description="Please verify your email address before creating, opening, or running projects."
              />
            ) : (
              <Row>
                <Col sm={24} md={24} lg={contentCol}>
                  <Space
                    orientation="vertical"
                    size={10}
                    style={{
                      width: "100%",
                      display: "flex",
                      padding: narrow ? "0 10px 0 10px" : "0",
                    }}
                  >
                    <div
                      ref={titleRef}
                      style={{
                        marginTop: mobileProjectsList ? "8px" : "20px",
                        display: "flex",
                        width: "100%",
                        gap: "10px",
                        alignItems: "center",
                        flexWrap: mobileProjectsList ? "wrap" : "nowrap",
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
                        <Icon name="edit" />{" "}
                        {intl.formatMessage(labels.projects)}
                      </Title>
                      <Button
                        ref={createNewRef}
                        type="primary"
                        onClick={handleCreateProject}
                        icon={<Icon name="plus-circle" />}
                      >
                        {capitalize(intl.formatMessage(labels.create))}
                      </Button>
                      <div
                        ref={starredBarRef}
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
                      ref={inviteInboxRef}
                      style={{ maxHeight: "50vh", overflow: "auto" }}
                    >
                      <IncomingInviteBanner
                        state={inviteState}
                        onReview={openInvitations}
                      />
                    </div>

                    {/* Table Controls (Search, Filters, Create Button) */}
                    <div ref={controlsRef}>
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
                    <div ref={operationsRef}>
                      <ProjectsOperations
                        visible_projects={visible_projects}
                        selected_project_ids={selectedProjectIds}
                        onSelectionChange={setSelectedProjectIds}
                        filteredCollaborators={filteredCollaborators}
                        onClearCollaboratorFilter={
                          handleClearCollaboratorFilter
                        }
                      />
                    </div>

                    <div ref={projectListRef}>
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
                          onFilteredCollaboratorsChange={
                            setFilteredCollaborators
                          }
                          selectedProjectIds={selectedProjectIds}
                          onSelectedProjectIdsChange={setSelectedProjectIds}
                          freezeOrder={backendWindowDirty}
                        />
                      )}
                    </div>
                  </Space>
                </Col>
              </Row>
            )}
          </div>
        </Layout.Content>
      </Layout>
      {!emailVerificationRequired && <ProjectDrawer />}
    </div>
  );
};
