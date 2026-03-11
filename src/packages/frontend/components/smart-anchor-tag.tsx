/*
A smart anchor tag that in some cases changes children to
look nicer, and opens special targets in the same cocalc
page or document (e.g., for uri fragments), and opens
external links in a new tab instead of leaving cocalc.

In all cases, we also stop mousedown propagation so clicking
on this link doesn't trigger drag and drop / select of container
element, if enabled (e.g., for links in sticky notes in the
whiteboard).
*/

import { Popover } from "antd";
import { join } from "path";
import { CSSProperties, ReactNode } from "react";
import { is_valid_uuid_string } from "@cocalc/util/misc";
import { hasHostAbsoluteRoutePrefix } from "@cocalc/util/routing/app";
import { redux } from "@cocalc/frontend/app-framework";
import { A, Icon, IconName } from "@cocalc/frontend/components";
import { file_associations } from "@cocalc/frontend/file-associations";
import {
  isCoCalcURL,
  parseCoCalcURL,
  removeOrigin,
} from "@cocalc/frontend/lib/cocalc-urls";
import Fragment, { FragmentId } from "@cocalc/frontend/misc/fragment-id";
import { ProjectTitle } from "@cocalc/frontend/projects/project-title";
import {
  containingPath,
  filename_extension,
  path_split,
} from "@cocalc/util/misc";
import { TITLE as SERVERS_TITLE } from "../project/servers";
import { alert_message } from "@cocalc/frontend/alerts";
import { load_target as globalLoadTarget } from "@cocalc/frontend/history";

interface Options {
  project_id: string;
  path: string;
  href?: string;
  title?: string;
  children?: ReactNode;
  style?: CSSProperties;
}

export default function SmartAnchorTag({
  href,
  title,
  children,
  project_id,
  path,
  style,
}: Options) {
  // compare logic here with frontend/misc/process-links/generic.ts
  let body;
  if (isInternalFileHref(href)) {
    body = (
      <InternalFileLink project_id={project_id} href={href} title={title}>
        {children}
      </InternalFileLink>
    );
  } else if (isCoCalcURL(href)) {
    body = (
      <CoCalcURL project_id={project_id} href={href} title={title}>
        {children}
      </CoCalcURL>
    );
  } else if (href?.includes("://") || href?.startsWith("mailto:")) {
    body = (
      <NonCoCalcURL href={href} title={title}>
        {children}
      </NonCoCalcURL>
    );
  } else if (href) {
    body = (
      <InternalRelativeLink
        project_id={project_id}
        path={path}
        href={href}
        title={title}
      >
        {children}
      </InternalRelativeLink>
    );
  } else {
    // Fallback: no href target at all, so no special handling needed...
    body = <a title={title}>{children}</a>;
  }
  // We check the type of style below since this component can receive invalid input from
  // the user (due to rendering html in markdown), e.g., a string for style, and it
  // is better to ignore it than crash everything.
  return (
    <span
      style={typeof style == "object" ? style : undefined}
      onMouseDown={(e) =>
        // This is so clicking links in something that is drag-n-droppable
        // doesn't trigger dragging:
        e.stopPropagation()
      }
    >
      {body}
    </span>
  );
}

const INTERNAL_FILE_LINK_PREFIX = "cocalc-file://";

function isInternalFileHref(href?: string): boolean {
  return typeof href === "string" && href.startsWith(INTERNAL_FILE_LINK_PREFIX);
}

function parseInternalFileHref(href: string): {
  path?: string;
  line?: number;
} {
  try {
    const url = new URL(href);
    if (url.protocol !== "cocalc-file:") return {};
    const rawPath = url.searchParams.get("path");
    if (!rawPath) return {};
    const parsedPath = parsePathWithOptionalLineSuffix(rawPath);
    const lineRaw = url.searchParams.get("line");
    const lineFromParam =
      lineRaw != null && /^\d+$/.test(lineRaw) && Number(lineRaw) > 0
        ? Number(lineRaw)
        : undefined;
    const line =
      lineFromParam ?? parsedPath.line ?? parseLineFromHashFragment(url.hash);
    return { path: parsedPath.path, line };
  } catch {
    return {};
  }
}

function parseLineFromHashFragment(hash?: string): number | undefined {
  if (!hash) return undefined;
  const cleaned = hash.startsWith("#") ? hash.slice(1) : hash;
  // Support GitHub-style #L123 and #L123C4 anchors often produced by agents.
  const match = cleaned.match(/^L(\d+)(?:C\d+)?(?:-L?\d+)?$/i);
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isFinite(line) && line > 0 ? line : undefined;
}

function parsePathWithOptionalLineSuffix(path: string): {
  path: string;
  line?: number;
} {
  const trimmed = path.trim();
  // Parse from the last :line(:col) suffix and allow common trailing
  // punctuation that can be attached in prose/code snippets.
  const match = trimmed.match(/^(.*):(\d+)(?::\d+)?(?:[)\].,;!?'"`]+)?$/);
  if (!match) return { path: trimmed };
  const candidatePath = match[1].trim();
  if (!candidatePath || candidatePath.endsWith("/")) {
    return { path: trimmed };
  }
  const line = Number(match[2]);
  if (!Number.isFinite(line) || line <= 0) {
    return { path: trimmed };
  }
  return { path: candidatePath, line };
}

function decodePathForParsing(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    try {
      return decodeURI(raw);
    } catch {
      return raw;
    }
  }
}

function parseAbsoluteFileHrefTarget(href: string): {
  path: string;
  line?: number;
} {
  try {
    const url = new URL(href, "http://dummy");
    const parsed = parsePathWithOptionalLineSuffix(
      decodePathForParsing(url.pathname),
    );
    const line = parsed.line ?? parseLineFromHashFragment(url.hash);
    return { path: parsed.path, line };
  } catch {
    return { path: href };
  }
}

function inferHomeFromCurrentPath(path?: string): string | undefined {
  if (!path) return undefined;
  const normalized = decodePathForParsing(path).replace(/\\/g, "/");
  const homeMatch = normalized.match(/^\/home\/[^/]+/);
  if (homeMatch) return homeMatch[0];
  if (normalized === "/root" || normalized.startsWith("/root/")) return "/root";
  return undefined;
}

async function resolveCrossMachineAbsolutePathFallback(opts: {
  actions: any;
  absolutePath: string;
  currentPath?: string;
}): Promise<string | undefined> {
  const fs = opts.actions?.fs?.();
  if (!fs?.exists) return undefined;
  const raw = decodePathForParsing(opts.absolutePath).replace(/\\/g, "/");
  if (!raw.startsWith("/")) return undefined;
  const home = inferHomeFromCurrentPath(opts.currentPath);
  if (!home) return undefined;
  const candidates = new Set<string>();

  const buildIdx = raw.indexOf("/build/");
  if (buildIdx >= 0) {
    const buildTail = raw.slice(buildIdx + 1);
    candidates.add(join(home, buildTail));
  }

  const srcIdx = raw.indexOf("/src/");
  if (srcIdx >= 0) {
    const srcTail = raw.slice(srcIdx + "/src/".length);
    candidates.add(join(home, "src", srcTail));
    const buildRoot = join(home, "build");
    try {
      const entries = await fs.readdir(buildRoot, { withFileTypes: true });
      for (const entry of entries ?? []) {
        const name = `${entry?.name ?? ""}`.trim();
        if (!name) continue;
        const isDirectory =
          typeof entry?.isDirectory === "function" ? entry.isDirectory() : true;
        if (!isDirectory) continue;
        candidates.add(join(buildRoot, name, "src", srcTail));
      }
    } catch {
      // best effort only
    }
  }

  for (const candidate of candidates) {
    if (!candidate || candidate === raw) continue;
    try {
      if (await fs.exists(candidate)) {
        return candidate;
      }
    } catch {
      // continue trying remaining candidates
    }
  }
  return undefined;
}

function isLikelyAbsoluteFilePathHref(href: string): boolean {
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//")) return false;
  if (/^\/[A-Za-z]:\//.test(href)) return true;
  if (hasHostAbsoluteRoutePrefix(href)) return false;
  return true;
}

// href starts with cocalc URL or is absolute,
// so we open the link directly inside this browser tab rather than
// opening an entirely new cocalc tab or navigating to it.
// NOTE: we assume children come from slate (i.e., it's markdown rendering)
// to do its magic; won't work well otherwise, but won't be broken.
// E.g., cocalc url's in html blocks don't get the treatment yet,
// but this is MUCH less likely to be needed, since there's no linkify
// happening there, so you're probably dealing with handcrafted a tags
// with proper children already.
function CoCalcURL({ href, title, children, project_id }) {
  const open = (e) => {
    const { project_id, page, target, fragmentId } = parseCoCalcURL(href);
    if (project_id && target) {
      e.preventDefault();
      try {
        loadTarget(
          page,
          project_id,
          decodeURI(target),
          !((e as any)?.which === 2 || e?.ctrlKey || e?.metaKey),
          fragmentId,
        );
      } catch (err) {
        // loadTarget could fail, e.g., if the project_id is mangled.
        alert_message({
          type: "error",
          message: `${err} -- the link is invalid`,
        });
      }
      return;
    } else if (page) {
      // opening a different top level page, e.g., all projects or account settings or something.
      e.preventDefault();
      globalLoadTarget(removeOrigin(href));
      return;
    }
    // fall back to default.
  };

  let message: ReactNode | undefined = undefined;
  let heading: ReactNode | undefined = undefined;
  let targetPath: string | undefined = undefined;
  let icon: IconName | undefined = undefined;
  const {
    project_id: target_project_id,
    target,
    fragmentId,
  } = parseCoCalcURL(href);
  if (target && target_project_id) {
    // NOTE/WARNING: This is kind of a lazy hack, and means that
    // this component assumes its immediate child is an a tag!
    // E.g., to fix something once I wrapped the a tag in a span
    // to impose style, and it broke this.
    const replaceChildren =
      href == children?.[0]?.props?.element?.text ||
      decodeURI(href) == children?.[0]?.props?.element?.text;

    if (target == "files" || target == "files/") {
      if (replaceChildren) {
        children = <>Files</>;
      }
      icon = "folder-open";
      heading = "Files";
      message = (
        <>
          Browse files in{" "}
          {project_id == target_project_id ? (
            "this project"
          ) : (
            <ProjectTitle project_id={target_project_id} />
          )}
          .
        </>
      );
    } else if (target.startsWith("files/")) {
      const rawPath = decodeURI(target).slice("files/".length);
      targetPath = rawPath;
      const filename = path_split(targetPath).tail;
      const hash = fragmentId ? `#${Fragment.encode(fragmentId)}` : "";
      if (project_id == target_project_id) {
        message = (
          <>
            Open <a onClick={open}>{filename}</a> in this project
            {fragmentId ? ` at ${hash}` : ""}
          </>
        );
      } else {
        message = (
          <>
            Open <a onClick={open}>{filename}</a> in the project{" "}
            <ProjectTitle project_id={target_project_id} />
            {fragmentId ? ` at ${hash}` : ""}
          </>
        );
      }
      if (replaceChildren) {
        children = (
          <>
            {targetPath}
            {hash}
          </>
        );
      }
      const ext = filename_extension(targetPath);
      const x = file_associations[ext];
      icon = x?.icon ?? "file";
      heading = <a onClick={open}>{targetPath}</a>;
    } else if (target.startsWith("settings")) {
      if (replaceChildren) {
        children = <>Settings</>;
      }
      icon = "wrench";
      heading = "Project Settings";
      message = (
        <>
          Open project settings in{" "}
          {project_id == target_project_id ? (
            "this project"
          ) : (
            <ProjectTitle project_id={target_project_id} />
          )}
          .
        </>
      );
    } else if (
      target === "apps" ||
      target.startsWith("apps/") ||
      target === "servers" ||
      target.startsWith("servers/")
    ) {
      if (replaceChildren) {
        children = <>{SERVERS_TITLE}</>;
      }
      icon = "server";
      heading = SERVERS_TITLE;
      message = (
        <>
          Open server management in{" "}
          {project_id == target_project_id ? (
            "this project"
          ) : (
            <ProjectTitle project_id={target_project_id} />
          )}
          .
        </>
      );
    } else if (target.startsWith("log")) {
      if (replaceChildren) {
        children = <>Log</>;
      }
      icon = "history";
      heading = "Project Log";
      message = (
        <>
          Open project log in{" "}
          {project_id == target_project_id ? (
            "this project"
          ) : (
            <ProjectTitle project_id={target_project_id} />
          )}
          .
        </>
      );
    } else if (target.startsWith("search")) {
      if (replaceChildren) {
        children = <>Find</>;
      }
      icon = "search";
      heading = "Search in Files";
      message = (
        <>
          Search through files in{" "}
          {project_id == target_project_id ? (
            "this project"
          ) : (
            <ProjectTitle project_id={target_project_id} />
          )}
          .
        </>
      );
    } else if (target.startsWith("new")) {
      targetPath = decodeURI(target).slice("new/".length);
      if (replaceChildren) {
        children = <>New</>;
      }
      icon = "plus-circle";
      heading = "Create New File";
      message = (
        <>
          Create a new file in{" "}
          {project_id == target_project_id ? (
            "this project"
          ) : (
            <ProjectTitle project_id={target_project_id} />
          )}{" "}
          in the{" "}
          {targetPath ? (
            <>directory "{targetPath}"</>
          ) : (
            "project root directory"
          )}
          .
        </>
      );
    }
  }

  const link = (
    <a
      title={title}
      href={href}
      target={"_blank"}
      rel={"noopener" /* only used in case of fallback */}
      onClick={open}
    >
      {icon ? <Icon name={icon} style={{ marginRight: "5px" }} /> : ""}
      {children}
    </a>
  );
  if (message || heading) {
    // refactor with cocalc/src/packages/frontend/frame-editors/frame-tree/path.tsx
    return (
      <Popover
        title={
          <b style={{ maxWidth: "400px" }}>
            {icon ? <Icon name={icon} style={{ marginRight: "5px" }} /> : ""}
            {heading}
          </b>
        }
        content={<div style={{ maxWidth: "400px" }}>{message}</div>}
      >
        {link}
      </Popover>
    );
  }
  return link;
}

// External non-cocalc URL. We open in a new tab.  There's a lot of
// opportunity to make these links look nice, similar to what we do
// with CoCalcURL above.  E.g., links to github could be made nicer
// if current directory is the same repo, etc.  However, that is
// for another day!
function NonCoCalcURL({ href, title, children }) {
  return (
    <A
      href={href}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      {children}
    </A>
  );
}

function InternalFileLink({ project_id, href, title, children }) {
  return (
    <a
      href={href}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!project_id) return;
        const target = parseInternalFileHref(href);
        if (!target.path) return;
        const actions = redux.getProjectActions(project_id);
        void (async () => {
          try {
            let isDir = actions.isDirViaCache?.(target.path!);
            if (
              typeof isDir !== "boolean" &&
              typeof actions.isDir === "function"
            ) {
              isDir = await actions.isDir(target.path!);
            }
            if (isDir === true) {
              actions.open_directory?.(target.path!);
              return;
            }
            await actions.open_file({
              path: target.path!,
              line: target.line,
              foreground: true,
              explicit: true,
            });
          } catch (err) {
            alert_message({
              type: "error",
              message: `Cannot open linked file: ${target.path} (${err})`,
            });
          }
        })();
      }}
    >
      {children}
    </a>
  );
}

// Internal relative link in the same project or even the
// same document (e.g., for a URI fragment).
function InternalRelativeLink({ project_id, path, href, title, children }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();

        if (href.startsWith("/")) {
          const absoluteTarget = parseAbsoluteFileHrefTarget(href);
          if (project_id && isLikelyAbsoluteFilePathHref(absoluteTarget.path)) {
            const actions = redux.getProjectActions(project_id);
            void (async () => {
              try {
                let isDir = actions.isDirViaCache?.(absoluteTarget.path);
                if (
                  typeof isDir !== "boolean" &&
                  typeof actions.isDir === "function"
                ) {
                  isDir = await actions.isDir(absoluteTarget.path);
                }
                if (isDir === true) {
                  actions.open_directory?.(absoluteTarget.path);
                  return;
                }
                await actions.open_file({
                  path: absoluteTarget.path,
                  line: absoluteTarget.line,
                  foreground: true,
                  explicit: true,
                });
              } catch (err) {
                const fallback = await resolveCrossMachineAbsolutePathFallback({
                  actions,
                  absolutePath: absoluteTarget.path,
                  currentPath: path,
                });
                if (fallback && fallback !== absoluteTarget.path) {
                  try {
                    let fallbackIsDir = actions.isDirViaCache?.(fallback);
                    if (
                      typeof fallbackIsDir !== "boolean" &&
                      typeof actions.isDir === "function"
                    ) {
                      fallbackIsDir = await actions.isDir(fallback);
                    }
                    if (fallbackIsDir === true) {
                      actions.open_directory?.(fallback);
                      return;
                    }
                    await actions.open_file({
                      path: fallback,
                      line: absoluteTarget.line,
                      foreground: true,
                      explicit: true,
                    });
                    return;
                  } catch {
                    // fall through to user-visible error below
                  }
                }
                alert_message({
                  type: "error",
                  message: `Cannot open linked file: ${absoluteTarget.path} (${err})`,
                });
              }
            })();
            return;
          }
          const openInSameTab = !(
            (e as any).which === 2 ||
            e.ctrlKey ||
            e.metaKey
          );
          if (openInSameTab) {
            window.location.assign(href);
          } else {
            window.open(href, "_blank", "noopener");
          }
          return;
        }

        if (!project_id) {
          // link is being opened outside of any specific project, e.g.,
          // opening /settings outside of a project will open cocalc-wide
          // settings for the user, not project settings.  E.g.,
          // this could happen in the messages panel.
          globalLoadTarget(href);
          return;
        }

        const dir = containingPath(path);
        const url = new URL("http://dummy/" + join(dir, href));
        let fragmentId = Fragment.decode(url.hash);
        const lineFromHash = parseLineFromHashFragment(url.hash);
        const hrefPlain = url.pathname.slice(1);
        let target;
        if (href.startsWith("#") || !hrefPlain) {
          // within the same file
          target = join("files", path);
        } else {
          // different file in the same project, with link being relative
          // to current path.
          const parsed = parsePathWithOptionalLineSuffix(
            decodePathForParsing(hrefPlain),
          );
          if (parsed.line != null && !fragmentId?.line) {
            fragmentId = {
              ...(fragmentId?.anchor ? {} : fragmentId),
              line: `${parsed.line}`,
            };
          } else if (lineFromHash != null && !fragmentId?.line) {
            fragmentId = {
              ...(fragmentId?.anchor ? {} : fragmentId),
              line: `${lineFromHash}`,
            };
          }
          target = join("files", parsed.path);
        }
        loadTarget(
          "projects",
          project_id,
          target,
          !((e as any).which === 2 || e.ctrlKey || e.metaKey),
          fragmentId,
        );
      }}
      title={title}
    >
      {children}
    </a>
  );
}

function loadTarget(
  page: string | undefined,
  project_id: string,
  target: string,
  switchTo: boolean,
  fragmentId?: FragmentId,
): void {
  if (!is_valid_uuid_string(project_id)) {
    throw Error(`invalid project id ${project_id}`);
  }
  if (page == "projects") {
    // open project:
    redux
      .getActions("projects")
      .open_project({ switch_to: switchTo, project_id });
    // open the file in the project
    redux
      .getProjectActions(project_id)
      .load_target(target, switchTo, false, true, fragmentId);
    if (switchTo) {
      // show project if switchTo
      redux.getActions("page").set_active_tab(project_id);
    }
  } else if (page && switchTo) {
    // not opening anything involving projects, e.g., opening
    // admin or settings or something else.
    redux.getActions("page").set_active_tab(page);
  }
}
