import { DSProvider, StoryCard } from "@cocalc/frontend";

// StoryCard — the surface card (IconBadge + title + muted body) used in the
// 3-up "story" grids on feature pages. `icon`, `title`, and `children` (the
// body text) are required; `accent` (hex) is optional. The card is height:100%,
// so each cell is wrapped in a constrained-width container to mimic its grid
// column. Copy is the real Jupyter-notebook page text from the guide.

export const KeepRunsAlive = () => (
  <DSProvider>
    <div style={{ width: 320 }}>
      <StoryCard icon="stopwatch" title="Keep runs alive">
        Start a long cell, disconnect, and return to the captured output. The
        browser tab is not the source of truth for execution.
      </StoryCard>
    </div>
  </DSProvider>
);

export const WorkTogetherLive = () => (
  <DSProvider>
    <div style={{ width: 320 }}>
      <StoryCard accent="#389e0d" icon="users" title="Work together live">
        Multiple people can edit, discuss, and inspect the same notebook.
        Collaboration stays in the document instead of becoming a screen-share
        workaround.
      </StoryCard>
    </div>
  </DSProvider>
);

export const ReviewAndRecover = () => (
  <DSProvider>
    <div style={{ width: 320 }}>
      <StoryCard accent="#7c3aed" icon="history" title="Review and recover changes">
        Notebook edits are recorded with authorship, so teams can recover work,
        review results, and understand how an analysis evolved.
      </StoryCard>
    </div>
  </DSProvider>
);
