/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A terminal artifact: the terminal session an agent works in, shown live
// with CoCalc's own terminal in this workbench frame.  The human watches and
// can type; the agent uses `cocalc project terminal write|history`.

import { Alert, Flex, Spin } from "antd";
import { useEffect } from "react";
import { terminal } from "../terminal-editor/terminal-spec";
import type { EditorComponentProps } from "../frame-tree/types";

export function TerminalArtifact({
  frameProps,
  termPath,
  sameProject,
}: {
  frameProps: EditorComponentProps;
  termPath: string;
  sameProject: boolean;
}) {
  const { actions, id, desc } = frameProps;
  const current = desc.get("data-termPath");
  useEffect(() => {
    if (!sameProject || current === termPath) return;
    // This frame may have shown another session: attach afresh.
    (actions as any).terminals?.close_terminal?.(id);
    actions.set_frame_data({ id, termPath });
  }, [actions, id, termPath, current, sameProject]);
  useEffect(
    () => () => {
      // Disconnect only; the session keeps running in the project.
      (actions as any).terminals?.close_terminal?.(id);
    },
    [actions, id],
  );
  if (!sameProject)
    return (
      <Flex
        align="center"
        justify="center"
        style={{ height: "100%", padding: 24 }}
      >
        <Alert
          type="info"
          showIcon
          title="This terminal is in another project"
          description="Open the chat it was published in to use it."
        />
      </Flex>
    );
  if (current !== termPath)
    return (
      <Flex align="center" justify="center" style={{ height: "100%" }}>
        <Spin />
      </Flex>
    );
  return terminal.component(frameProps);
}
