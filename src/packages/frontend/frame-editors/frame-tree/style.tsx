import type { CSSProperties, ReactNode } from "react";
import { COLORS } from "@cocalc/util/theme";
import { path_split } from "@cocalc/util/misc";

export const TITLE_BAR_BORDER = `1px solid ${COLORS.GRAY_DDD}`;

export const FRAME_TAB_BAR_STYLE: CSSProperties = {
  margin: 0,
  padding: "0 8px",
  borderBottom: TITLE_BAR_BORDER,
} as const;

export function buildSwitchToFileItems(
  files: string[],
  mainPath: string,
  currentPath: string | undefined,
  onClick: (path: string) => void,
): { key: string; label: ReactNode; onClick: () => void }[] {
  return files.map((filePath) => {
    const filename = path_split(filePath).tail;
    const isMain = filePath === mainPath;
    const isCurrent = filePath === currentPath;
    const label = (
      <>
        {isCurrent ? <b>{filename}</b> : filename}
        {isMain ? " (main)" : ""}
      </>
    );
    return {
      key: filePath,
      label,
      onClick: () => onClick(filePath),
    };
  });
}
