/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  Component,
  type AnchorHTMLAttributes,
  type ErrorInfo,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { essentialRouteUrl, navigate, type UltraliteRoute } from "./routes";
import { fullProjectUrl, siteUrl } from "./urls";
import { UltraliteIcon, type UltraliteIconName } from "./icons";
import { recordUltraliteOutcome } from "./telemetry";
import { useEssentialTheme } from "./theme-context";

export function EssentialLink({
  children,
  route,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> & {
  route: UltraliteRoute;
}) {
  return (
    <a
      {...props}
      href={essentialRouteUrl(route)}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          (props.target != null && props.target !== "_self") ||
          props.download !== undefined
        ) {
          return;
        }
        event.preventDefault();
        navigate(route);
      }}
    >
      {children}
    </a>
  );
}

export function OverflowMenu({
  children,
  className = "",
  label = "More actions",
  summary,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
  summary?: ReactNode;
}) {
  return (
    <details
      className={`ul-overflow ${className}`.trim()}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.currentTarget.removeAttribute("open");
        event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
      }}
    >
      <summary aria-label={label} title={label}>
        {summary ?? <UltraliteIcon name="more" />}
      </summary>
      <div
        className="ul-overflow-panel"
        onClick={(event) =>
          event.currentTarget.parentElement?.removeAttribute("open")
        }
      >
        {children}
      </div>
    </details>
  );
}

export function ThemeControl() {
  const { preference, setPreference } = useEssentialTheme();
  return (
    <label className="ul-theme-control" title={`Appearance: ${preference}`}>
      <UltraliteIcon
        name={
          preference === "system"
            ? "desktop"
            : preference === "dark"
              ? "moon"
              : "sun"
        }
        size={16}
      />
      <select
        aria-label="Color theme"
        onChange={(event) =>
          setPreference(event.target.value as "system" | "light" | "dark")
        }
        value={preference}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

export function TopBar({ projectTitle }: { projectTitle?: string }) {
  return (
    <header className="ul-topbar">
      <a aria-label="CoCalc home" className="ul-brand" href={siteUrl("")}>
        <span aria-hidden="true" className="ul-brand-mark">
          CoCalc
        </span>
      </a>
      {projectTitle ? (
        <div className="ul-topbar-project" title={projectTitle}>
          {projectTitle}
        </div>
      ) : (
        <EssentialLink
          className="ul-topbar-title ul-topbar-title-link"
          route={{ kind: "projects" }}
        >
          Projects
        </EssentialLink>
      )}
      <span className="ul-mode">Essential</span>
      <EssentialLink className="ul-topbar-link" route={{ kind: "docs" }}>
        <UltraliteIcon name="docs" size={16} />
        Docs
      </EssentialLink>
      <EssentialLink
        aria-label="Notifications"
        className="ul-topbar-link"
        route={{ kind: "notifications" }}
      >
        <UltraliteIcon name="bell" size={16} />
        Notifications
      </EssentialLink>
      <a className="ul-topbar-link" data-ul-full-cocalc href={siteUrl("app")}>
        Full CoCalc
        <UltraliteIcon name="external" size={15} />
      </a>
      <ThemeControl />
    </header>
  );
}

interface PrimaryNavItem {
  icon: UltraliteIconName;
  kind:
    | "agents"
    | "apps"
    | "cli"
    | "files"
    | "notebooks"
    | "recent"
    | "settings"
    | "terminal"
    | "vms";
  label: string;
}

const PRIMARY_NAV: PrimaryNavItem[] = [
  { icon: "folder", kind: "files", label: "Files" },
  { icon: "chat", kind: "agents", label: "Codex" },
  { icon: "notebook", kind: "notebooks", label: "Jupyter" },
  { icon: "terminal", kind: "terminal", label: "Terminal" },
];

const SECONDARY_NAV: Array<
  Omit<PrimaryNavItem, "kind"> & {
    kind: "apps" | "cli" | "recent" | "settings" | "vms";
  }
> = [
  { icon: "recent", kind: "recent", label: "Recent" },
  { icon: "server", kind: "vms", label: "VMs" },
  { icon: "apps", kind: "apps", label: "Apps" },
  { icon: "code", kind: "cli", label: "CLI" },
  { icon: "settings", kind: "settings", label: "Settings" },
];

export function ProjectRail({
  active,
  project,
}: {
  active: UltraliteRoute["kind"];
  project: AccountProjectListWindowRow;
}) {
  const secondarySelected = SECONDARY_NAV.some(({ kind }) => active === kind);
  return (
    <nav aria-label="Project tools" className="ul-project-rail">
      <EssentialLink className="ul-rail-item" route={{ kind: "projects" }}>
        <UltraliteIcon name="projects" />
        <span>Projects</span>
      </EssentialLink>
      <div aria-hidden="true" className="ul-rail-rule" />
      {PRIMARY_NAV.map(({ icon, kind, label }) => {
        const selected =
          active === kind || (kind === "files" && active === "file");
        return (
          <EssentialLink
            aria-current={selected ? "page" : undefined}
            className={`ul-rail-item ${selected ? "ul-rail-item-active" : ""}`}
            key={kind}
            route={
              kind === "files"
                ? {
                    kind: "files",
                    projectId: project.project_id,
                    path: "/home/user",
                  }
                : { kind, projectId: project.project_id }
            }
          >
            <UltraliteIcon name={icon} />
            <span>{label}</span>
          </EssentialLink>
        );
      })}
      <OverflowMenu
        className={`ul-rail-more ${secondarySelected ? "ul-rail-more-active" : ""}`}
        label="More project tools"
        summary={
          <>
            <UltraliteIcon name="more" />
            <span>More</span>
          </>
        }
      >
        {SECONDARY_NAV.map(({ icon, kind, label }) => (
          <EssentialLink
            className="ul-menu-item"
            key={kind}
            route={{ kind, projectId: project.project_id }}
          >
            <UltraliteIcon name={icon} size={16} />
            {label}
          </EssentialLink>
        ))}
      </OverflowMenu>
      <a
        className="ul-rail-item ul-rail-full"
        data-ul-full-cocalc
        href={fullProjectUrl({ projectId: project.project_id })}
      >
        <UltraliteIcon name="external" />
        <span>Full</span>
      </a>
    </nav>
  );
}

export function ProjectLayout({
  children,
  project,
  route,
}: {
  children: ReactNode;
  project: AccountProjectListWindowRow;
  route: UltraliteRoute;
}) {
  return (
    <div className="ul-project-layout">
      <ProjectRail active={route.kind} project={project} />
      <div className="ul-project-content">{children}</div>
    </div>
  );
}

export function InlineAlert({
  children,
  kind = "info",
}: {
  children: ReactNode;
  kind?: "error" | "info" | "warning";
}) {
  return (
    <div
      className={`ul-alert ul-alert-${kind}`}
      role={kind === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div aria-live="polite" className="ul-state ul-loading-state">
      <span aria-hidden="true" className="ul-spinner" />
      <span>{label}</span>
    </div>
  );
}

export function ShellLoading() {
  return (
    <main className="ul-shell-loading" id="main-content">
      <LoadingState label="Opening CoCalc" />
    </main>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="ul-state ul-empty">{children}</div>;
}

export function SurfaceHeader({
  actions,
  eyebrow,
  title,
}: {
  actions?: ReactNode;
  eyebrow?: string;
  title: string;
}) {
  return (
    <div className="ul-surface-header">
      <div>
        {eyebrow ? <div className="ul-eyebrow">{eyebrow}</div> : null}
        <h1 tabIndex={-1}>{title}</h1>
      </div>
      {actions ? <div className="ul-toolbar">{actions}</div> : null}
    </div>
  );
}

interface ChunkErrorBoundaryProps {
  children: ReactNode;
  label: string;
}

interface ChunkErrorBoundaryState {
  error?: string;
}

export class ChunkErrorBoundary extends Component<
  ChunkErrorBoundaryProps,
  ChunkErrorBoundaryState
> {
  state: ChunkErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): ChunkErrorBoundaryState {
    return { error: error instanceof Error ? error.message : `${error}` };
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Rspack chunk failures are reported by the standard static error path.
    recordUltraliteOutcome("shell", "chunk_failure");
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="ul-page" id="main-content">
        <SurfaceHeader title={`${this.props.label} could not be displayed`} />
        <InlineAlert kind="error">
          The panel assets could not be loaded. Reload this focused client to
          fetch the current static build.
        </InlineAlert>
        <button
          className="ul-button"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload CoCalc
        </button>
      </main>
    );
  }
}
