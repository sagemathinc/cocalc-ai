import { DSProvider, EmptySection } from "@cocalc/frontend";

// EmptySection — the empty / not-found state (antd Empty with the simple
// presented image, description set from `label`) inside a PublicSection. Used
// across about/news/policies for missing or filtered-out content. `label` is
// the only prop (required string); these are real phrasings from the pages.

export const TeamProfileNotFound = () => (
  <DSProvider>
    <EmptySection label="This team profile was not found." />
  </DSProvider>
);

export const NoEventsFound = () => (
  <DSProvider>
    <EmptySection label="No events found." />
  </DSProvider>
);

export const NewsFilterNoMatch = () => (
  <DSProvider>
    <EmptySection label="No news items match the selected filter." />
  </DSProvider>
);

export const PolicyPageNotFound = () => (
  <DSProvider>
    <EmptySection label="This policy page was not found." />
  </DSProvider>
);
