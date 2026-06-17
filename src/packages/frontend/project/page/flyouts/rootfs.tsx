/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import RootFilesystemImage from "@cocalc/frontend/project/settings/root-filesystem-image";
import { FLYOUT_PADDING } from "./consts";

interface Props {
  project_id: string;
  wrap: (content: React.JSX.Element) => React.JSX.Element;
}

export function RootfsFlyout({ wrap }: Readonly<Props>): React.JSX.Element {
  return wrap(
    <div style={{ padding: `0 ${FLYOUT_PADDING} ${FLYOUT_PADDING} 0` }}>
      <RootFilesystemImage />
    </div>,
  );
}
