/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import NewFilePage from "@cocalc/frontend/project/new/new-file-page";
import type React from "react";

export function NewFlyout({
  project_id,
  wrap,
  isVisible = true,
}: {
  project_id: string;
  wrap: (content: React.ReactNode) => React.JSX.Element;
  isVisible?: boolean;
}): React.JSX.Element {
  return wrap(
    <NewFilePage project_id={project_id} mode="flyout" isVisible={isVisible} />,
  );
}
