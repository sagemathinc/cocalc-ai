import { FOCUSED_COLOR } from "../../util";

export default function getStyles(focused: boolean = false) {
  const border = `1px solid ${focused ? FOCUSED_COLOR : "transparent"}`;
  return {
    divStyle: { border, display: "flex", justifyContent: "center" },
    // Collapsed borders with a grid in the theme's border color, so the table
    // reads as one table in light and dark mode (row shading spans the row,
    // not separate cell boxes), and empty cells keep a size you can click.
    tableStyle: {
      borderCollapse: "collapse",
      margin: "5px 0",
    },
    cellStyle: {
      border: "1px solid var(--cocalc-ui-border, #d9d9d9)",
      padding: "4px 12px",
      minWidth: "3em",
      height: "1.8em",
    },
  } as const;
}
