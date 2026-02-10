/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Tooltip } from "antd";
import { TimeTravelActions } from "./actions";
import { Icon } from "../../components";
import type { Document } from "@cocalc/sync/editor/generic/types";

interface Props {
  actions: TimeTravelActions;
  version: number | string | undefined;
  doc: () => Document | undefined;
  gitMode?: boolean;
}

export function RevertFile({
  actions,
  version,
  doc,
  gitMode,
}: Props) {
  return (
    <Tooltip
      title={
        "Restore the file to the displayed version (this creates a new version, so nothing is lost)."
      }
    >
      <Button
        onClick={() => {
          if (version != null) {
            const v =
              typeof version === "string" ? version : `${version ?? ""}`;
            const d = doc();
            if (d != null) {
              actions.revert({ version: v, doc: d, gitMode });
            }
          }
        }}
        disabled={version == null || actions.syncdoc?.is_read_only()}
      >
        <Icon name="undo" /> Restore This Version
      </Button>
    </Tooltip>
  );
}
