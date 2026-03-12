/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";

import useIsMountedRef from "@cocalc/frontend/app-framework/is-mounted-hook";
import { JupyterActions } from "@cocalc/frontend/jupyter/browser-actions";
import { InputPrompt } from "@cocalc/frontend/jupyter/prompt/input";
import { useFrameContext } from "../../hooks";
import { getJupyterActions } from "./actions";

export default function CodeInputPrompt({ element }) {
  const { project_id, path } = useFrameContext();
  const [actions, setActions] = useState<JupyterActions | undefined>(undefined);
  const isMountedRef = useIsMountedRef();

  useEffect(() => {
    let closed = false;
    void (async () => {
      const actions = await getJupyterActions({ project_id, path });
      if (closed || !isMountedRef.current) return;
      setActions(actions);
    })();
    return () => {
      closed = true;
    };
  }, [isMountedRef, path, project_id]);
  return (
    <InputPrompt
      style={{ textAlign: undefined }}
      type="code"
      exec_count={element.data?.execCount}
      state={element.data?.runState}
      kernel={element.data?.kernel}
      start={element.data?.start}
      end={element.data?.end}
      actions={actions}
      id={element.id}
    />
  );
}
