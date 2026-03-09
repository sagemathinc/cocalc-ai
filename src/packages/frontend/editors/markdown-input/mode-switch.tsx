import { Popover, Radio } from "antd";
import { MutableRefObject, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";
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

  if (hidden) {
    return null;
  }

  function toggleMenu() {
    setMenuOpen((open) => !open);
  }

  function renderEllipsis() {
    return (
      <span style={{ fontWeight: 400 }}>
        {"\u22EF"}
        <Popover
          open={isFocusedFrame && isVisible && menuOpen}
          content={
            <div style={{ display: "flex" }}>
              {editBarContentRef.current}
              <Icon
                onClick={() => setMenuOpen(false)}
                name="times"
                style={{
                  color: COLORS.GRAY_M,
                  marginTop: "5px",
                }}
              />
            </div>
          }
        />
      </span>
    );
  }

  return (
    <div
      style={layout === "inline" ? { display: "flex", alignItems: "center" } : undefined}
      onMouseDown={onInteractionStart}
      onMouseUp={onInteractionEnd}
      onTouchStart={onInteractionStart}
      onTouchEnd={onInteractionEnd}
      onTouchCancel={onInteractionEnd}
    >
      <div
        style={{
          background: "white",
          color: COLORS.GRAY_M,
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
        <Radio.Group
          options={[
            ...(overflowEllipsis && mode == "editor"
              ? [
                  {
                    label: renderEllipsis(),
                    value: "menu",
                    style: {
                      backgroundColor: menuOpen ? COLORS.GRAY_L : "white",
                      paddingLeft: 10,
                      paddingRight: 10,
                    },
                  },
                ]
              : []),
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
            if (nextMode === "menu") {
              toggleMenu();
            } else {
              onSelectMode(nextMode as Mode);
            }
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
