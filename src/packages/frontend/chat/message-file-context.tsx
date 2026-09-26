/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useMemo } from "react";
import type { ReactNode } from "react";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import getAnchorTagComponent from "@cocalc/frontend/project/page/anchor-tag-component";
import getUrlTransform from "@cocalc/frontend/project/page/url-transform";
import { joinAbsolutePath } from "@cocalc/util/path-model";

export function AgentMessageFileContext({
  projectId,
  directory,
  children,
}: {
  projectId?: string;
  directory?: string;
  children: ReactNode;
}) {
  const parent = useFileContext();
  // Keep the generated anchor component stable while the response streams.
  const value = useMemo(() => {
    if (!projectId || !directory) return parent;
    const location = {
      project_id: projectId,
      path: joinAbsolutePath(directory, ".cocalc-agent-links"),
    };
    return {
      ...parent,
      ...location,
      relativeLinkBasePath: directory,
      anchorTagAction: undefined,
      AnchorTagComponent: getAnchorTagComponent(location),
      urlTransform: getUrlTransform(location),
    };
  }, [parent, projectId, directory]);
  return <FileContext.Provider value={value}>{children}</FileContext.Provider>;
}
