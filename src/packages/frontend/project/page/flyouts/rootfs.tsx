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

export function RootfsPanel({
  layout = "flyout",
}: {
  layout?: "flyout" | "page";
}): React.JSX.Element {
  const page = layout === "page";
  return (
    <div
      style={{
        boxSizing: "border-box",
        minWidth: 0,
        padding: page ? "24px" : `14px ${FLYOUT_PADDING} ${FLYOUT_PADDING} 0`,
        width: "100%",
      }}
    >
      <div
        style={{
          boxSizing: "border-box",
          margin: page ? "0 auto" : undefined,
          maxWidth: page ? 1120 : undefined,
          minWidth: 0,
          width: "100%",
        }}
      >
        <RootFilesystemImage mode={page ? "page" : "flyout"} />
      </div>
    </div>
  );
}

export function RootfsFlyout({ wrap }: Readonly<Props>): React.JSX.Element {
  return wrap(<RootfsPanel />);
}
