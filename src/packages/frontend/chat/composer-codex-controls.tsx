/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button, Typography } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const { Text } = Typography;

export const composerPillStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: 0,
  borderRadius: 999,
  color: UI_COLORS.secondary,
  cursor: "pointer",
  display: "inline-flex",
  font: "inherit",
  lineHeight: 1.2,
  minWidth: 0,
  paddingBottom: 2,
  paddingLeft: 5,
  paddingRight: 5,
  paddingTop: 2,
  whiteSpace: "nowrap",
};

export const ComposerPillButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }
>(function ComposerPillButton({ children, style, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      style={{ ...composerPillStyle, ...style }}
    >
      {children}
    </button>
  );
});

export function displayComposerWorkingDirectory(
  directory: string,
  home: string,
): string {
  if (directory === home) return "~";
  if (directory.startsWith(`${home}/`)) {
    return `~/${directory.slice(home.length + 1)}`;
  }
  return directory;
}

interface ProjectDirectoryButtonProps {
  projectTitle: string;
  directory: string;
  displayedDirectory: string;
  disabled?: boolean;
  onClick?: () => void;
}

export const ComposerProjectDirectoryButton = forwardRef<
  HTMLButtonElement,
  ProjectDirectoryButtonProps
>(function ComposerProjectDirectoryButton(
  { projectTitle, directory, displayedDirectory, disabled, onClick },
  ref,
) {
  return (
    <Button
      ref={ref}
      aria-label={`Working directory: ${projectTitle} / ${directory}`}
      aria-haspopup="dialog"
      disabled={disabled}
      icon={<Icon name="folder-open" />}
      onClick={onClick}
      size="small"
      type="text"
      style={{
        color: UI_COLORS.secondary,
        display: "inline-flex",
        flex: "0 1 auto",
        maxWidth: 240,
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          flex: "0 1 110px",
          minWidth: 24,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {projectTitle}
      </span>
      <Text type="secondary" style={{ flex: "0 0 auto" }}>
        &nbsp;/&nbsp;
      </Text>
      <span
        style={{
          flex: "1 1 70px",
          minWidth: 50,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {displayedDirectory}
      </span>
    </Button>
  );
});
