/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { lazy, Suspense, useState } from "react";
import { Button, Drawer, Spin } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

const ProjectDetails = lazy(() => import("./project-details"));
const WIDTH_KEY = "cocalc-agents-project-drawer-width";

export function ProjectSettingsDrawer({
  projectId,
  title,
  open,
  onClose,
}: {
  projectId?: string;
  title?: string;
  open: boolean;
  onClose: () => void;
}) {
  const projects = useTypedRedux("projects", "project_map");
  const projectTitle = projectId
    ? projects?.getIn([projectId, "title"])
    : undefined;
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(WIDTH_KEY)) || 560;
    } catch {
      return 560;
    }
  });
  function resize(value: number) {
    const next = Math.max(280, Math.min(window.innerWidth, value));
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {}
  }
  return (
    <Drawer
      title={
        typeof projectTitle === "string" && projectTitle
          ? projectTitle
          : title || "Project settings"
      }
      open={open}
      onClose={onClose}
      placement="right"
      size={width}
      destroyOnHidden
      resizable={{ onResize: resize }}
      extra={
        <Button onClick={() => resize(width === 560 ? 400 : 560)}>
          Resize
        </Button>
      }
    >
      <KeyboardBoundary>
        {open && projectId && (
          <Suspense fallback={<Spin />}>
            <ProjectDetails
              key={projectId}
              projectId={projectId}
              onClose={onClose}
            />
          </Suspense>
        )}
      </KeyboardBoundary>
    </Drawer>
  );
}
