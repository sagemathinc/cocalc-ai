import { Drawer, Space } from "antd";
import { Suspense } from "react";
import { useIntl } from "react-intl";
import {
  useActions,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { Loading } from "@cocalc/frontend/components/loading";
import { labels } from "@cocalc/frontend/i18n";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import { CocalcErrorBoundary } from "@cocalc/frontend/app/error-boundary";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";

const ProjectRowExpandedContent = lazyWithRetry<{ project_id: string }>(
  async () => {
    const [, content] = await Promise.all([
      ensureProjectReduxRuntime(),
      import("./project-row-expanded-content"),
    ]);
    return { default: content.ProjectRowExpandedContent };
  },
  "project details drawer",
);

const DRAWER_SIZE_STORAGE_KEY = "cocalc:projects:drawerWidth";
const MIN_DRAWER_WIDTH = 360;
const MAX_DRAWER_WIDTH = 960;

function clampDrawerWidth(width: number): number {
  return Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, width));
}

function readDrawerWidth(): number | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const raw = window.localStorage.getItem(DRAWER_SIZE_STORAGE_KEY);
  if (raw == null) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return clampDrawerWidth(parsed);
}

function persistDrawerWidth(width: number) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(
    DRAWER_SIZE_STORAGE_KEY,
    String(clampDrawerWidth(width)),
  );
}

export function ProjectDrawer() {
  const intl = useIntl();
  const actions = useActions("projects");
  const expanded_project_id = useTypedRedux("projects", "expanded_project_id");
  const project_map = useTypedRedux("projects", "project_map");
  const project = expanded_project_id
    ? project_map?.get(expanded_project_id)
    : undefined;
  const title = project?.get("title") ?? intl.formatMessage(labels.project);
  const [drawerWidth, setDrawerWidth] = useState<number | undefined>(
    readDrawerWidth,
  );

  const handleResize = (next: number) => {
    const clamped = clampDrawerWidth(next);
    setDrawerWidth(clamped);
    try {
      persistDrawerWidth(clamped);
    } catch {}
  };

  return (
    <Drawer
      size={drawerWidth}
      placement="right"
      title={
        <Space>
          <Icon name="folder-open" /> {title}
        </Space>
      }
      onClose={() => actions.set_expanded_project(undefined)}
      resizable={{ onResize: handleResize }}
      open={!!expanded_project_id}
    >
      {expanded_project_id && (
        <CocalcErrorBoundary
          autoRetry={false}
          resetKeys={[expanded_project_id]}
          scope="projects.details-drawer"
        >
          <Suspense fallback={<Loading theme="medium" />}>
            <ProjectRowExpandedContent project_id={expanded_project_id} />
          </Suspense>
        </CocalcErrorBoundary>
      )}
    </Drawer>
  );
}
