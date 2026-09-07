/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Badge, Button, Drawer, Layout } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { ChatRoomSidebar } from "./chatroom-sidebar";

const CHAT_LAYOUT_STYLE: React.CSSProperties = {
  height: "100%",
  background: UI_COLORS.page,
} as const;

interface ChatRoomLayoutProps {
  variant: "default" | "compact";
  sidebarWidth: number;
  setSidebarWidth: (value: number) => void;
  sidebarVisible: boolean;
  setSidebarVisible: (value: boolean) => void;
  totalUnread: number;
  sidebarContent: React.ReactNode;
  chatContent: React.ReactNode;
  onNewChat: () => void;
  newChatSelected: boolean;
  hideSidebar?: boolean;
}

export function ChatRoomLayout({
  variant,
  sidebarWidth,
  setSidebarWidth,
  sidebarVisible,
  setSidebarVisible,
  totalUnread,
  sidebarContent,
  chatContent,
  onNewChat,
  newChatSelected,
  hideSidebar = false,
}: ChatRoomLayoutProps) {
  if (hideSidebar) {
    return (
      <div
        className="smc-vfill"
        style={{ background: UI_COLORS.page, minHeight: 0 }}
      >
        {chatContent}
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div className="smc-vfill" style={{ background: UI_COLORS.page }}>
        <Drawer
          open={sidebarVisible}
          onClose={() => setSidebarVisible(false)}
          placement="right"
          title="Chats"
          destroyOnHidden
          resizable
        >
          <KeyboardBoundary boundary="chat-drawer">
            {sidebarContent}
          </KeyboardBoundary>
        </Drawer>
        <div
          style={{
            padding: "10px",
            display: "flex",
            gap: "8px",
            justifyContent: "flex-end",
          }}
        >
          <Button
            icon={<Icon name="bars" />}
            onClick={() => setSidebarVisible(true)}
          >
            Chats
            <Badge count={totalUnread} overflowCount={99} />
          </Button>
          <Button
            type={newChatSelected ? "primary" : "default"}
            onClick={onNewChat}
          >
            New Chat
          </Button>
        </div>
        {chatContent}
      </div>
    );
  }

  return (
    <Layout
      hasSider
      style={{
        ...CHAT_LAYOUT_STYLE,
        position: "relative",
        minHeight: 0,
        height: "100%",
        display: "flex",
        flexDirection: "row",
      }}
    >
      <ChatRoomSidebar width={sidebarWidth} setWidth={setSidebarWidth}>
        {sidebarContent}
      </ChatRoomSidebar>
      <Layout.Content
        className="smc-vfill"
        style={{
          background: UI_COLORS.page,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          height: "100%",
        }}
      >
        {chatContent}
      </Layout.Content>
    </Layout>
  );
}
