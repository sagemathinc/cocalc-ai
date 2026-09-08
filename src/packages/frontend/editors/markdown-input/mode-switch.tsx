import { Button, Popover, Radio } from "antd";
import { useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { Mode } from "./types";

interface MarkdownInputModeSwitchProps {
  mode: Mode;
  layout?: "float" | "inline";
  isFocusedFrame?: boolean;
  isVisible?: boolean;
  hideHelp?: boolean;
  hidden?: boolean;
  overflowEllipsis?: boolean;
  style?: React.CSSProperties;
  editBarContentRef: MutableRefObject<React.JSX.Element | undefined>;
  onSelectMode: (mode: Mode) => void;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
}

export function MarkdownInputModeSwitch({
  mode,
  layout = "float",
  isFocusedFrame,
  isVisible,
  hideHelp,
  hidden,
  overflowEllipsis = true,
  style,
  editBarContentRef,
  onSelectMode,
  onInteractionStart,
  onInteractionEnd,
}: MarkdownInputModeSwitchProps) {
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  if (hidden) {
    return null;
  }

  function closeMenu() {
    setMenuOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  function renderEllipsis() {
    return (
      <Popover
        open={isFocusedFrame && isVisible && menuOpen}
        trigger="click"
        onOpenChange={setMenuOpen}
        afterOpenChange={(open) => {
          if (open)
            popupRef.current
              ?.querySelector<HTMLButtonElement>("button")
              ?.focus({ preventScroll: true });
        }}
        content={
          <KeyboardBoundary
            boundary="markdown-formatting"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu();
              }
            }}
          >
            <div
              ref={popupRef}
              role="dialog"
              aria-label="Text formatting"
              style={{
                maxWidth: "calc(100vw - 48px)",
                maxHeight: "60dvh",
                overflowY: "auto",
              }}
            >
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button
                  type="text"
                  aria-label="Close formatting"
                  icon={<Icon name="times" />}
                  onClick={closeMenu}
                  style={{ minWidth: 44, minHeight: 44 }}
                />
              </div>
              {editBarContentRef.current}
            </div>
          </KeyboardBoundary>
        }
      >
        <Button
          ref={triggerRef}
          size="small"
          aria-label="Text formatting"
          aria-haspopup="dialog"
          aria-expanded={!!(isFocusedFrame && isVisible && menuOpen)}
          icon={<Icon name="ellipsis" />}
          style={{
            background: menuOpen ? UI_COLORS.hover : UI_COLORS.surface,
          }}
        />
      </Popover>
    );
  }

  return (
    <div
      data-markdown-mode-switch="true"
      style={
        layout === "inline"
          ? { display: "flex", alignItems: "center" }
          : undefined
      }
      onMouseDownCapture={onInteractionStart}
      onMouseUp={onInteractionEnd}
      onTouchStartCapture={onInteractionStart}
      onTouchEnd={onInteractionEnd}
      onTouchCancel={onInteractionEnd}
    >
      <div
        style={{
          background: UI_COLORS.surface,
          color: UI_COLORS.secondary,
          display: "inline-flex",
          alignItems: "center",
          ...(layout === "float"
            ? mode == "editor" || hideHelp
              ? {
                  float: "right",
                  position: "relative",
                  zIndex: 1,
                }
              : { float: "right" }
            : {
                position: "relative",
                zIndex: 1,
                display: "inline-flex",
              }),
          ...style,
        }}
      >
        {overflowEllipsis && mode === "editor" && renderEllipsis()}
        <Radio.Group
          options={[
            {
              label: <span style={{ fontWeight: 400 }}>Rich Text</span>,
              value: "editor",
            },
            {
              label: <span style={{ fontWeight: 400 }}>Markdown</span>,
              value: "markdown",
            },
          ]}
          onChange={(e) => {
            const nextMode = e.target.value;
            if (typeof document !== "undefined") {
              const active = document.activeElement;
              if (
                active instanceof HTMLElement &&
                active.closest?.("[data-markdown-mode-switch='true']") != null
              ) {
                active.blur();
              }
            }
            setMenuOpen(false);
            onSelectMode(nextMode as Mode);
            queueMicrotask(onInteractionEnd);
          }}
          value={mode}
          optionType="button"
          size="small"
          buttonStyle="solid"
          style={{ display: "block" }}
        />
      </div>
    </div>
  );
}
