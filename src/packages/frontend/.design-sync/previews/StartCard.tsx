import { DSProvider, StartCard } from "@cocalc/frontend";

// StartCard — the muted-surface "next step" card (title + body + primary CTA)
// that closes feature pages. All four props required; content here is the real
// unauthenticated copy from the Julia / board / slides feature pages.

export const StartInProject = () => (
  <DSProvider>
    <StartCard
      title="Start in a project"
      body="Open a project and use Julia in notebooks, terminals, Pluto, source files, or teaching workflows."
      href="/auth/sign-up"
      label="Create account"
    />
  </DSProvider>
);

export const StartWithBoard = () => (
  <DSProvider>
    <StartCard
      title="Start with a board"
      body="Open a project and create a board for technical diagrams, lecture notes, research sketches, or computational workflows."
      href="/auth/sign-up"
      label="Create account"
    />
  </DSProvider>
);

export const StartWithDeck = () => (
  <DSProvider>
    <StartCard
      title="Start with a deck"
      body="Open a project and create a slide deck for a lecture, demo, or research presentation."
      href="/auth/sign-up"
      label="Start making slides"
    />
  </DSProvider>
);
