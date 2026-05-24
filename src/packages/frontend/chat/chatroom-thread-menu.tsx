/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { MenuProps } from "antd";
import { Button, Dropdown, message as antdMessage } from "antd";
import type { MouseEvent, ReactNode } from "react";
import { Icon } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";
import type { ChatActions } from "./actions";
import type { ChatExportOpenRequest } from "./export-types";

export interface ChatRoomThreadMenuProps {
  actions: ChatActions;
  threadKey: string;
  plainLabel: string;
  hasCustomName?: boolean;
  isPinned?: boolean;
  isAI?: boolean;
  isCodexThread?: boolean;
  threadColor?: string;
  threadIcon?: string;
  openAppearanceModal: (
    threadKey: string,
    plainLabel: string,
    hasCustomName: boolean,
    threadColor?: string,
    threadIcon?: string,
  ) => void;
  openBehaviorModal: (threadKey: string) => void;
  openGitBrowser?: (threadKey: string) => void;
  openExportModal: (opts?: ChatExportOpenRequest) => void;
  openImportModal: () => void;
  openForkModal: (threadKey: string, label: string, isAI: boolean) => void;
  confirmResetThread: (threadKey: string, label: string) => void;
  confirmDeleteThread: (threadKey: string, label: string) => void;
  openChatFile?: () => void;
  openAutomationModal?: (threadKey: string) => void;
  showClearThread?: boolean;
  buttonLabel?: ReactNode;
  buttonSize?: "small" | "middle" | "large";
  buttonType?: "link" | "text" | "default" | "primary" | "dashed";
  buttonAriaLabel?: string;
  buttonTestId?: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  onButtonClick?: (event: MouseEvent<HTMLElement>) => void;
}

export function stripThreadHtml(value: string): string {
  if (!value) return "";
  return value.replace(/<[^>]*>/g, "");
}

export function ChatRoomThreadMenu({
  actions,
  threadKey,
  plainLabel,
  hasCustomName = false,
  isPinned = false,
  isAI = false,
  isCodexThread = false,
  threadColor,
  threadIcon,
  openAppearanceModal,
  openBehaviorModal,
  openGitBrowser,
  openExportModal,
  openImportModal,
  openForkModal,
  confirmResetThread,
  confirmDeleteThread,
  openChatFile,
  openAutomationModal,
  showClearThread = true,
  buttonLabel,
  buttonSize = "small",
  buttonType = "text",
  buttonAriaLabel = "Chat thread actions",
  buttonTestId,
  open,
  onOpenChange,
  onButtonClick,
}: ChatRoomThreadMenuProps) {
  const codexItems: NonNullable<MenuProps["items"]> =
    isCodexThread && openGitBrowser
      ? [
          {
            key: "git-browser",
            label: "Git browser",
          },
        ]
      : [];
  const automationItems: NonNullable<MenuProps["items"]> =
    isAI && openAutomationModal
      ? [
          {
            key: "automation",
            label: "Automation settings…",
          },
        ]
      : [];

  const menu: MenuProps = {
    items: [
      { key: "appearance", label: "Appearance..." },
      { key: "behavior", label: "Behavior..." },
      ...(openChatFile
        ? [
            {
              key: "open-chat-file",
              label: "Open Chat File",
            },
          ]
        : []),
      {
        key: isPinned ? "unpin" : "pin",
        label: isPinned ? "Unpin chat" : "Pin chat",
      },
      {
        key: "archive",
        label: "Archive chat",
      },
      ...automationItems,
      ...codexItems,
      {
        type: "divider",
      },
      {
        key: "export",
        label: "Export...",
      },
      {
        key: "import",
        label: "Import...",
      },
      {
        key: "fork",
        label: "Fork chat…",
      },
      ...(showClearThread
        ? [
            {
              key: "clear",
              label: "Clear thread",
            },
          ]
        : []),
      {
        type: "divider",
      },
      {
        key: "delete",
        label: <span style={{ color: COLORS.ANTD_RED }}>Delete chat</span>,
      },
    ],
    onClick: ({ key }) => {
      if (key === "appearance") {
        openAppearanceModal(
          threadKey,
          plainLabel,
          hasCustomName,
          threadColor,
          threadIcon,
        );
      } else if (key === "behavior") {
        openBehaviorModal(threadKey);
      } else if (key === "open-chat-file") {
        openChatFile?.();
      } else if (key === "pin" || key === "unpin") {
        if (!actions?.setThreadPin) {
          antdMessage.error("Pinning chats is not available.");
          return;
        }
        const pinned = key === "pin";
        const success = actions.setThreadPin(threadKey, pinned);
        if (!success) {
          antdMessage.error("Unable to update chat pin state.");
          return;
        }
        antdMessage.success(pinned ? "Chat pinned." : "Chat unpinned.");
      } else if (key === "export") {
        openExportModal({
          scope: "current-thread",
          threadKey,
          label: plainLabel,
        });
      } else if (key === "import") {
        openImportModal();
      } else if (key === "fork") {
        openForkModal(threadKey, plainLabel, isAI);
      } else if (key === "clear") {
        confirmResetThread(threadKey, plainLabel);
      } else if (key === "archive") {
        if (!actions?.setThreadArchived) {
          antdMessage.error("Archiving chats is not available.");
          return;
        }
        const success = actions.setThreadArchived(threadKey, true);
        if (!success) {
          antdMessage.error("Unable to archive chat.");
          return;
        }
        antdMessage.success("Chat archived.");
      } else if (key === "automation") {
        openAutomationModal?.(threadKey);
      } else if (key === "git-browser") {
        openGitBrowser?.(threadKey);
      } else if (key === "delete") {
        confirmDeleteThread(threadKey, plainLabel);
      }
    },
  };

  return (
    <Dropdown
      menu={menu}
      trigger={["click"]}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Button
        type={buttonType}
        size={buttonSize}
        aria-label={buttonAriaLabel}
        data-testid={buttonTestId}
        onClick={onButtonClick}
        icon={buttonLabel == null ? <Icon name="ellipsis" /> : undefined}
      >
        {buttonLabel}
      </Button>
    </Dropdown>
  );
}
