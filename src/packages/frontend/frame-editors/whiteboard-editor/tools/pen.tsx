/*
The pen panel.
*/

import { Button, Tooltip } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import ToolPanel, { getPresetManager, Tool } from "./tool-panel";
import { defaultRadius, maxRadius as defaultMaxRadius } from "./defaults";
import { SELECTED, WHITEBOARD_COMPACT_BUTTON_STYLE } from "./common";

interface Params {
  color?: string;
  countdown?: number;
  radius?: number;
  opacity?: number;
}

export const COLORS = [
  "#252937",
  "#95067a",
  "#2b6855",
  "#53b79c",
  "#c1003c",
  "#82bc0e",
  "#009ac1",
  "#411a09",
];
/*
  "#db482d",
  "#e0d200",
  "#002bdb",
  "#6a4acb",
];
*/

const RADS = [2, 5];

const HIGHLIGHTER = -1;
const ERASER = -2;

const numBrushes = COLORS.length * RADS.length;

function kthPreset(k) {
  return {
    //radius: RADS[Math.floor(k / COLORS.length) % RADS.length],
    //color: COLORS[k % COLORS.length] ?? "#000",
    radius: RADS[k % RADS.length] ?? defaultRadius,
    color: COLORS[Math.floor(k / RADS.length) % COLORS.length] ?? "#000",
  };
}

const DEFAULTS: Params[] = [];
for (let id = 0; id < numBrushes; id++) {
  DEFAULTS.push(kthPreset(id));
}

const tool = "pen" as Tool;

export default function PenToolPanel() {
  return (
    <ToolPanel
      tool={tool}
      presetManager={presetManager}
      Preview={BrushPreview}
      buttonTitle={({ color, radius, opacity }: Params) =>
        `Color: ${color}, Radius: ${radius}px` +
        (opacity ? `, Opacity: ${opacity}` : "")
      }
      editableParams={new Set(["radius", "color", "opacity"])}
      style={{ width: "128px", paddingBottom: "6px" }}
      presetContainerStyle={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: "6px",
        justifyItems: "center",
        padding: "0 6px 4px",
      }}
      presetStyle={{
        width: "52px",
        height: "52px",
        minHeight: "52px",
        marginTop: 0,
      }}
      editParamsStyle={{ left: "136px" }}
      AlternateTop={AlternateTop}
    />
  );
}

const presetManager = getPresetManager<Params>(tool, DEFAULTS, {
  [HIGHLIGHTER]: { color: "#ffff00", opacity: 0.4, radius: 15 },
  [ERASER]: { color: "#ffffff", radius: 15 },
});

function AlternateTop({
  setSelected,
  selected,
}: {
  setSelected: (number) => void;
  selected: number;
}) {
  const fontSize = "20px";
  const buttonStyle = {
    ...WHITEBOARD_COMPACT_BUTTON_STYLE,
    width: "28px",
    minHeight: "28px",
    borderRadius: "6px",
  } as const;
  return (
    <div
      style={{
        margin: "6px 6px 10px 6px",
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        justifyItems: "center",
        rowGap: "4px",
        columnGap: "4px",
        padding: "6px",
        borderRadius: "10px",
        background: "#fafafa",
      }}
    >
      <div
        style={{
          gridColumn: "1 / -1",
          textAlign: "center",
          color: "#666",
          fontSize: "14px",
        }}
      >
        Pen
      </div>
      <Tooltip title="Pen (customize below)">
        <Button
          style={{
            ...buttonStyle,
            background: selected >= 0 ? "#e6f4ff" : undefined,
          }}
          type="text"
          onClick={() => setSelected(0)}
        >
          <Icon
            style={{ fontSize, color: selected >= 0 ? SELECTED : undefined }}
            name="pencil"
          />
        </Button>
      </Tooltip>
      <Tooltip title="Highlighter (a wide transparent pen)">
        <Button
          style={{
            ...buttonStyle,
            background: selected == HIGHLIGHTER ? "#e6f4ff" : undefined,
          }}
          type="text"
          onClick={() => setSelected(HIGHLIGHTER)}
        >
          <Icon
            style={{
              fontSize,
              color: selected == HIGHLIGHTER ? SELECTED : undefined,
            }}
            name="blog"
          />
        </Button>
      </Tooltip>
      <Tooltip title="Whiteout (a wide white pen)">
        <Button
          style={{
            ...buttonStyle,
            background: selected == ERASER ? "#e6f4ff" : undefined,
          }}
          type="text"
          onClick={() => setSelected(ERASER)}
        >
          <Icon
            style={{
              fontSize,
              color: selected == ERASER ? SELECTED : undefined,
            }}
            name="eraser"
          />
        </Button>
      </Tooltip>
    </div>
  );
}

export function BrushPreview({
  radius,
  color,
  maxRadius = defaultMaxRadius,
}: {
  radius: number;
  color: string;
  maxRadius?: number;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: `${(maxRadius + 1) * 2}px`,
        height: `${(maxRadius + 1) * 2}px`,
        boxSizing: "border-box",
        borderRadius: `${maxRadius + 1}px`,
        background: "white",
        border: `3px solid ${color ?? "#ccc"}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: `${Math.min(radius, maxRadius - 2) * 2}px`,
          height: `${Math.min(radius, maxRadius - 2) * 2}px`,
          borderRadius: `${Math.min(radius, maxRadius - 2)}px`,
          background: color,
        }}
      ></div>
    </div>
  );
}
