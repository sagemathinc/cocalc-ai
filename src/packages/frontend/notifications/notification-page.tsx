/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Flex, Modal } from "antd";
import { useEffect, useState } from "react";
import { useIntl } from "react-intl";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { useInviteInboxState } from "@cocalc/frontend/collaborators";
import { A, Loading, Paragraph, Title } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import { labels } from "@cocalc/frontend/i18n";
import Fragment from "@cocalc/frontend/misc/fragment-id";
import { COLORS } from "@cocalc/util/theme";
import { NotificationFilter } from "./mentions/types";
import { NotificationList } from "./notification-list";
import { NotificationNav } from "./notification-nav";

export function NotificationPage() {
  const intl = useIntl();
  const account_id = useTypedRedux("account", "account_id");
  const mentions = useTypedRedux("mentions", "mentions");
  const loading = useTypedRedux("mentions", "loading");
  const mentions_unread = useTypedRedux("mentions", "unread_count") ?? 0;
  const inviteState = useInviteInboxState({
    includeOutgoing: false,
    includeBlocks: false,
  });
  const invite_unread = inviteState.incoming.length;
  const unread_count = mentions_unread + invite_unread;
  const news_unread = useTypedRedux("news", "unread") ?? 0;
  const news = useTypedRedux("news", "news");
  const user_map = useTypedRedux("users", "user_map");
  const filter: NotificationFilter = useTypedRedux("mentions", "filter");

  useEffect(() => {
    Fragment.set({ page: filter });
  }, [filter]);

  const [showHelp, setShowHelp] = useState<boolean>(false);

  function renderExplanation() {
    return (
      <Paragraph style={{ color: COLORS.GRAY_D, flex: "0 0 auto" }}>
        {intl.formatMessage(
          {
            id: "notifications.page.intro",
            description:
              "The @ sign in front of a user name handle is used to notify someone else.",
            defaultMessage: `This page contains news and when someone used "@your_name" to explicitly mention you as a collaborator in a <A1>Chatroom</A1>,
            in the context of <A2>teaching</A2>, or <A3>when editing files.</A3>
            When editing text in a Jupyter notebook or whiteboard,
            type an @ symbol, then select the name of a collaborator,
            and they will receive an email and be listed under mentions, telling them that
            you mentioned them. You can also "@mention" yourself for testing or to make it
            easy to find something later.`,
          },
          {
            A1: (c) => <A href="https://doc.cocalc.com/chat.html">{c}</A>,
            A2: (c) => (
              <A href="https://doc.cocalc.com/teaching-interactions.html#mention-collaborators-in-chat">
                {c}
              </A>
            ),
            A3: (c) => (
              <A href="https://doc.cocalc.com/markdown.html#mentions">{c}</A>
            ),
          },
        )}
      </Paragraph>
    );
  }

  function renderContent() {
    if (filter == null || account_id == null) {
      return <Loading theme="medium" />;
    }

    return (
      <Flex style={{ overflow: "hidden", flex: 1 }}>
        <NotificationNav
          filter={filter}
          on_click={redux.getActions("mentions").set_filter}
          unread_count={unread_count}
          news_unread={news_unread}
          style={{
            display: "flex",
            flexDirection: "column",
            width: "200px",
            overflowY: "auto",
            marginRight: "10px",
            // paddingRight = so more scrollbar friendly
            paddingRight: "15px",
          }}
        />
        <NotificationList
          account_id={account_id}
          inviteState={inviteState}
          loading={loading}
          mentions={mentions}
          news={news}
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            overflowY: "auto",
          }}
          user_map={user_map}
          filter={filter}
        />
      </Flex>
    );
  }

  return (
    <div
      className="smc-vfill"
      style={{
        padding: "0 30px 15px 30px",
        display: "flex",
        flexDirection: "row",
        justifyContent: "center",
        overflowY: "hidden",
      }}
    >
      <div className="smc-vfill" style={{ maxWidth: "1400px" }}>
        <Title
          level={2}
          style={{ textAlign: "center", flex: "0 0 auto", marginTop: "10px" }}
        >
          <Icon name="comments" style={{ marginRight: "10px" }} />{" "}
          {intl.formatMessage(labels.notifications)}
          <Button
            type="link"
            style={{ fontSize: "12pt" }}
            onClick={() => setShowHelp(true)}
          >
            <Icon name="question-circle" />
          </Button>
        </Title>
        {renderContent()}
        <Modal
          width={600}
          title={
            <>
              <Icon name="question-circle" />{" "}
              {intl.formatMessage(labels.notifications)}
            </>
          }
          open={showHelp}
          onCancel={() => setShowHelp(false)}
          onOk={() => setShowHelp(false)}
        >
          {renderExplanation()}
        </Modal>
      </div>
    </div>
  );
}
