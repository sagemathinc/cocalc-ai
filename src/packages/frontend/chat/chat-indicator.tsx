/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// TODO: for a frame tree it really only makes sense for this button
// to always show the chat. For older legacy content it should hide
// and show it.  But it's very hard to know from here which doc type
// this is... so for now it still sort of toggles.  For now things
// do work properly via a hack in close_chat in project_actions.

import { isChatPath } from "./paths";
import { Button } from "antd";
import { debounce } from "lodash";
import { useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { UsersViewing } from "@cocalc/frontend/account/avatar/users-viewing";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { HiddenXS, Tooltip } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import track from "@cocalc/frontend/user-tracking";
import { labels } from "../i18n";
import { lite } from "@cocalc/frontend/lite";
import type { ChatActions } from "./actions";
import { ensureSideChatActions, hasUnreadSideChat } from "./unread";

export type ChatState =
  | "" // not opened (also undefined counts as not open)
  | "internal" // chat is open and managed internally (via frame tree)
  | "external" // chat is open and managed externally (e.g., legacy editor)
  | "pending"; // chat should be opened when the file itself is actually initialized.

const CHAT_INDICATOR_STYLE: React.CSSProperties = {
  fontSize: "15pt",
  paddingTop: "2px",
  cursor: "pointer",
  background: "#e8e8e8",
  borderTop: "2px solid lightgrey",
} as const;

const USERS_VIEWING_STYLE: React.CSSProperties = {
  maxWidth: "120px",
  marginRight: "5px",
} as const;

interface Props {
  project_id: string;
  path: string;
  chatState?: ChatState;
}

export function ChatIndicator({ project_id, path, chatState }: Props) {
  const style: React.CSSProperties = {
    ...CHAT_INDICATOR_STYLE,
    ...{ display: "flex" },
  };
  return (
    <div style={style}>
      {!lite && (
        <UsersViewing
          project_id={project_id}
          path={path}
          style={USERS_VIEWING_STYLE}
        />
      )}
      <ChatButton project_id={project_id} path={path} chatState={chatState} />
    </div>
  );
}

function ChatButton({ project_id, path, chatState }) {
  const intl = useIntl();
  const account_id = useTypedRedux("account", "account_id");
  const [chatActions, setChatActions] = useState<ChatActions | undefined>();
  const [chatVersion, setChatVersion] = useState(0);

  const toggleChat = debounce(
    () => {
      const actions = redux.getProjectActions(project_id);
      if (chatState) {
        track("close-chat", { project_id, path, how: "chat-button" });
        actions.close_chat({ path });
      } else {
        track("open-chat", { project_id, path, how: "chat-button" });
        actions.open_chat({ path });
      }
    },
    1000,
    { leading: true },
  );

  useEffect(() => {
    if (isChatPath(path)) {
      setChatActions(undefined);
      return;
    }
    setChatActions(ensureSideChatActions(project_id, path));
  }, [project_id, path]);

  useEffect(() => {
    if (!chatActions?.store) {
      return;
    }
    const refresh = () => {
      setChatVersion((value) => value + 1);
    };
    chatActions.store.on("change", refresh);
    refresh();
    return () => {
      chatActions.store?.removeListener("change", refresh);
    };
  }, [chatActions]);

  const isNewChat = useMemo(
    () => hasUnreadSideChat({ actions: chatActions, account_id }),
    [account_id, chatActions, chatVersion],
  );

  if (isChatPath(path)) {
    // Special case: do not show side chat for chatrooms
    return null;
  }

  return (
    <Tooltip
      title={
        <span>
          <Icon name="comment" style={{ marginRight: "5px" }} />
          <FormattedMessage
            id="chat.chat-indicator.tooltip"
            defaultMessage={"Hide or Show Document Chat"}
          />
        </span>
      }
      placement={"leftTop"}
      mouseEnterDelay={0.5}
    >
      <Button
        type="text"
        danger={isNewChat}
        className={isNewChat ? "smc-chat-notification" : undefined}
        onClick={toggleChat}
        style={{ background: chatState ? "white" : undefined }}
      >
        <Icon name="comment" />
        <HiddenXS>
          <span style={{ marginLeft: "5px" }}>
            {intl.formatMessage(labels.chat)}
          </span>
        </HiddenXS>
      </Button>
    </Tooltip>
  );
}
