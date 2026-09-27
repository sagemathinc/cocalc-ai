/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";
import type { ReactNode } from "react";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import type { IFileContext } from "@cocalc/frontend/lib/file-context";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import { joinAbsolutePath } from "@cocalc/util/path-model";
import { ChatSourceFileContext } from "./source-file-context";

export function AgentMessageFileContext({
  projectId,
  path,
  directory,
  children,
}: {
  projectId?: string;
  path?: string;
  directory?: string;
  children: ReactNode;
}) {
  const parent = useFileContext();
  // Keep the generated anchor component stable while the response streams.
  const value = useMemo<IFileContext>(() => {
    if (!projectId || !directory) return parent;
    const location = {
      project_id: projectId,
      path: joinAbsolutePath(directory, ".cocalc-agent-links"),
    };
    const sourcePath = path ?? parent.path;
    const RelativeAnchor = getAnchorTagComponent(location);
    const SourceAnchor =
      parent.AnchorTagComponent ??
      getAnchorTagComponent({ project_id: projectId, path: sourcePath ?? "" });
    return {
      ...parent,
      project_id: projectId,
      path: sourcePath,
      relativeLinkBasePath: directory,
      anchorTagAction: undefined,
      AnchorTagComponent: (props) =>
        props.href?.trim().startsWith("#") ? (
          <SourceAnchor
            href={props.href}
            title={props.title}
            children={props.children}
            style={props.style}
          />
        ) : (
          <RelativeAnchor
            href={props.href}
            title={props.title}
            children={props.children}
            style={props.style}
          />
        ),
      urlTransform: getUrlTransform(location),
    };
  }, [parent, projectId, path, directory]);
  return (
    <ChatSourceFileContext.Provider value={parent}>
      <FileContext.Provider value={value}>{children}</FileContext.Provider>
    </ChatSourceFileContext.Provider>
  );
}
