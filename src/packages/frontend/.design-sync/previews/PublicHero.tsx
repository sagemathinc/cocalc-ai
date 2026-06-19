import { DSProvider, LinkButton, PublicHero } from "@cocalc/frontend";

// PublicHero — the page-top hero (h1 title + optional subtitle + optional
// actions) that self-wraps in a PublicSection. `title` is the only required
// prop; subtitle/actions are optional ReactNode. Copy is the real public
// Guides and Translations landing-page content.

export const GuidesHero = () => (
  <DSProvider>
    <PublicHero
      title="Guides"
      subtitle="Narrative walkthroughs for common CoCalc workflows. Start with a guide when you want a practical path through the work; use docs when you need reference details for this CoCalc site."
      actions={
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <LinkButton href="/guides">Open all guides</LinkButton>
          <LinkButton href="/docs">Browse docs</LinkButton>
        </div>
      }
    />
  </DSProvider>
);

export const TranslationsHero = () => (
  <DSProvider>
    <PublicHero
      title="Translations for CoCalc"
      subtitle="Open a language-specific overview of CoCalc. These pages are intentionally minimal public landing pages for discovery and SEO."
    />
  </DSProvider>
);

export const TitleOnly = () => (
  <DSProvider>
    <PublicHero title="Guides" />
  </DSProvider>
);
