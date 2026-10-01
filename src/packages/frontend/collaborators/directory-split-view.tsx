/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Children, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, Popover, Splitter } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

/** Keep both panels mounted: changing layout must not discard a chat draft. */
export function DirectorySplitView({
  children,
  hasDetail,
  controlsTarget,
  id,
  labelledBy,
  selectionKey,
}: {
  children: ReactNode;
  hasDetail: boolean;
  controlsTarget: HTMLElement | null;
  id: string;
  labelledBy: string;
  selectionKey?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1000);
  const [width, setWidth] = useState(320);
  const [hidden, setHidden] = useState(false);
  const [mobileResults, setMobileResults] = useState(false);
  const [resizeOpen, setResizeOpen] = useState(false);
  const resizeTrigger = useRef<HTMLButtonElement>(null);
  const rangeId = useId();
  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setContainerWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setMobileResults(false), [hasDetail, selectionKey]);
  const narrow = containerWidth < 680;
  const maxWidth = Math.max(240, Math.min(600, containerWidth - 360));
  const panelWidth = Math.min(maxWidth, Math.max(240, width));
  const visible = !hasDetail || (narrow ? mobileResults : !hidden);
  const panels = Children.toArray(children);
  const controls = hasDetail && (
    <>
      <Button
        type="text"
        aria-label={visible ? "Hide results" : "Show results"}
        title={visible ? "Hide results" : "Show results"}
        aria-expanded={visible}
        aria-controls={`${id}-results`}
        icon={<Icon name={visible ? "chevron-left" : "chevron-right"} />}
        onClick={() =>
          narrow ? setMobileResults(!visible) : setHidden(!hidden)
        }
      />
      {!narrow && visible && (
        <Popover
          trigger="click"
          open={resizeOpen}
          onOpenChange={setResizeOpen}
          content={
            <KeyboardBoundary
              boundary="results-size"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setResizeOpen(false);
                  resizeTrigger.current?.focus();
                }
              }}
            >
              <label htmlFor={rangeId}>Results panel width</label>
              <input
                id={rangeId}
                type="range"
                min={240}
                max={maxWidth}
                step={10}
                value={panelWidth}
                onChange={(event) => setWidth(Number(event.target.value))}
                style={{ display: "block", width: 200, marginTop: 8 }}
              />
            </KeyboardBoundary>
          }
        >
          <Button
            ref={resizeTrigger}
            type="text"
            aria-label="Resize results panel"
            title="Resize results panel"
            aria-expanded={resizeOpen}
            icon={<Icon name="sliders" />}
          />
        </Popover>
      )}
    </>
  );
  return (
    <div
      ref={container}
      className="collaborators-columns"
      role="tabpanel"
      id={id}
      aria-labelledby={labelledBy}
      data-detail={hasDetail}
      data-results-visible={visible}
    >
      {controlsTarget && createPortal(controls, controlsTarget)}
      <Splitter
        onResize={(sizes) => setWidth(sizes[0])}
        onDraggerDoubleClick={() => setWidth(320)}
      >
        <Splitter.Panel
          size={!visible ? 0 : !hasDetail || narrow ? "100%" : panelWidth}
          min={visible && hasDetail && !narrow ? 240 : 0}
          max={hasDetail && !narrow ? maxWidth : undefined}
          resizable={hasDetail && !narrow && visible}
        >
          <div
            id={`${id}-results`}
            className="collaborators-results-pane"
            inert={!visible}
          >
            {panels[0]}
          </div>
        </Splitter.Panel>
        <Splitter.Panel
          size={!hasDetail || (narrow && visible) ? 0 : undefined}
          min={hasDetail && !narrow ? 320 : 0}
          resizable={hasDetail && !narrow && visible}
        >
          <div
            className="collaborators-detail-pane"
            inert={!hasDetail || (narrow && visible)}
          >
            {panels[1]}
          </div>
        </Splitter.Panel>
      </Splitter>
    </div>
  );
}
