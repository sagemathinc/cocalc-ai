/*
ipywidgets: each widget renders in its own opaque frame (see
../widgets/frame/), never in this page.
*/

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cocalc/frontend/components/icon";
import { Alert, Button } from "antd";
import type { JupyterActions } from "../browser-actions";
import { Map } from "immutable";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { once } from "@cocalc/util/async-utils";
import { WidgetFrame } from "../widgets/frame/widget-frame";

const MAX_WAIT = 5000;

interface WidgetProps {
  value: Map<string, any>;
  actions?: JupyterActions;
  directory?: string;
  trust?: boolean;
  id?: string;
}

export function IpyWidget({ id: cell_id, value, actions }: WidgetProps) {
  const [unknown, setUnknown] = useState<boolean>(false);
  // We *ONLY* render widgets when they are visible, for efficiency.
  const { isVisible } = useFrameContext();
  const [isReady, setIsReady] = useState<boolean>(false);
  const valueRef = useRef<any>(value);
  const model_id = value.get("model_id");
  const ipywidgets_state = actions?.syncdb?.ipywidgets_state;

  // The model's state may arrive after the output that displays it (the
  // notebook and its widget state sync separately): wait a bit for it.
  useEffect(() => {
    let canceled = false;
    valueRef.current = value;
    setUnknown(false);
    void (async () => {
      if (ipywidgets_state == null) {
        if (!canceled) setIsReady(true);
        return;
      }
      if (ipywidgets_state.get_state() !== "ready") {
        try {
          await once(ipywidgets_state, "ready", MAX_WAIT);
        } catch {
          if (!canceled) setIsReady(true);
          return;
        }
      }
      const start = Date.now();
      while (!canceled && Date.now() - start <= MAX_WAIT) {
        if (!valueRef.current.equals(value)) {
          // let new function take over
          return;
        }
        if (ipywidgets_state.getSerializedModelState(model_id) != null) {
          setIsReady(true);
          return;
        } else {
          setIsReady(false);
        }
        try {
          await once(ipywidgets_state, "change", MAX_WAIT);
        } catch {
          break;
        }
      }
      if (!canceled) setIsReady(true);
    })();
    return () => {
      canceled = true;
    };
  }, [actions, value]);

  useEffect(() => {
    if (!isReady || ipywidgets_state == null) return;
    setUnknown(
      ipywidgets_state.get_state() !== "ready" ||
        ipywidgets_state.getSerializedModelState(model_id) == null,
    );
  }, [isReady, model_id]);

  const relay = actions?.widgetRelay();
  if (unknown) {
    const msg = "Run cell to load widget";
    return (
      <Alert
        showIcon
        style={{ margin: "15px" }}
        type="warning"
        title={
          actions != null && cell_id ? (
            <Button
              type="link"
              onClick={() => {
                actions.runCells([cell_id]);
              }}
            >
              <Icon name="step-forward" /> {msg}
            </Button>
          ) : (
            <span>{msg}</span>
          )
        }
      />
    );
  }
  if (!isVisible || !isReady || relay == null) {
    return <div />;
  }
  return <WidgetFrame relay={relay} model_id={model_id} />;
}
