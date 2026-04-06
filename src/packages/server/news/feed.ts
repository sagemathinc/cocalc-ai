/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import {
  NEWS_FEED_STREAM_CONFIG,
  newsFeedStreamName,
  type NewsFeedEvent,
} from "@cocalc/conat/hub/api/news-feed";

const logger = getLogger("server:news:feed");

export async function publishNewsFeedEvent(
  event: NewsFeedEvent,
): Promise<void> {
  const stream = conat().sync.astream<NewsFeedEvent>({
    name: newsFeedStreamName(),
    ephemeral: true,
    config: NEWS_FEED_STREAM_CONFIG,
  });
  await stream.publish(event);
}

export async function publishNewsRefreshBestEffort(): Promise<void> {
  try {
    await publishNewsFeedEvent({ type: "news.refresh", ts: Date.now() });
  } catch (err) {
    logger.warn("failed to publish news refresh event", { err: `${err}` });
  }
}
