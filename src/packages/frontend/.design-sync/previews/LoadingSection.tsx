import { DSProvider, LoadingSection } from "@cocalc/frontend";

// LoadingSection — the in-page loading state (a small antd Spin + label text
// inside a PublicSection) shown while about/news data fetches. `label` is the
// only prop (required string). Two distinct real labels exist across the site.

export const LoadingEvents = () => (
  <DSProvider>
    <LoadingSection label="Loading events…" />
  </DSProvider>
);

export const LoadingNewsItem = () => (
  <DSProvider>
    <LoadingSection label="Loading news item…" />
  </DSProvider>
);
