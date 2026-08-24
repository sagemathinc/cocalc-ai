/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The Run button in a frame title bar: runs the code file being edited in a
terminal frame next to it.  Visibility is decided by the title bar; by the
time this renders, the file is known to be runnable.
*/

import { Button } from "antd";
import { useIntl } from "react-intl";

import type { CSS } from "@cocalc/frontend/app-framework";
import { Icon, Tooltip, VisibleMDLG } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { buildRunCommand } from "../code-editor/run-commands";

interface Props {
  // the frame that asked to run; a terminal is split off next to it
  id: string;
  // the file this frame shows, which is what gets run
  path: string;
  // frame tree actions -- they own the frames
  actions;
  // actions of the file, when that is not the file of the frame tree
  documentActions?;
  noLabel?: boolean;
  size?: "small" | undefined;
  style?: CSS;
}

export default function RunButton({
  id,
  path,
  actions,
  documentActions,
  noLabel,
  size,
  style,
}: Props) {
  const intl = useIntl();
  const label = intl.formatMessage(labels.run);
  // Without the cd prefix -- this is for the user to read, not what we send.
  const command = buildRunCommand(path, { cd: false });
  return (
    <Tooltip
      title={
        <>
          {intl.formatMessage({
            id: "frame_editors.frame_tree.title_bar.run.tooltip",
            defaultMessage:
              "Run this file in a terminal (shift+enter). It is saved first.",
            description: "Tooltip of the Run button for a code file",
          })}
          {command != null ? (
            <div style={{ marginTop: "5px" }}>
              <code>{command}</code>
            </div>
          ) : undefined}
        </>
      }
    >
      <Button
        aria-label={label}
        style={style}
        size={size}
        onClick={() => {
          actions.run_code(id, documentActions);
        }}
      >
        <Icon name="play-circle" />
        {noLabel ? undefined : (
          <VisibleMDLG>
            <span style={{ marginLeft: "5px" }}>{label}</span>
          </VisibleMDLG>
        )}
      </Button>
    </Tooltip>
  );
}
