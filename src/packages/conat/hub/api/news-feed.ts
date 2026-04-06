import type { Configuration } from "@cocalc/conat/persist/storage";

export interface NewsFeedEvent {
  type: "news.refresh";
  ts: number;
}

export function newsFeedStreamName(): string {
  return "news-feed";
}

export const NEWS_FEED_STREAM_CONFIG: Partial<Configuration> = {
  max_msgs: 100,
  max_age: 15 * 60 * 1000,
  max_bytes: 256 * 1024,
};
