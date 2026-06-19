import {
  DSProvider,
  LinkButton,
  PublicCard,
  PublicGrid,
  PublicSection,
} from "@cocalc/frontend";

// PublicSection — a public-page <section> with an optional h2 title, optional
// lead intro paragraph, optional aria-label, and required children. The variant
// axis is which of title/intro/ariaLabel are present. Children mirror real
// production usage: a PublicGrid of PublicCards, a lead paragraph, a CTA row,
// or a heading + paragraph block.

export const PolicyResources = () => (
  <DSProvider>
    <PublicSection
      title="Policy and trust resources"
      intro="Use these pages when you need the formal terms, privacy, data-processing, trust, accessibility, copyright, or education-policy materials behind a CoCalc evaluation."
    >
      <PublicGrid columns={3}>
        <PublicCard href="/policies/imprint" title="Imprint">
          Site-specific legal imprint information.
        </PublicCard>
        <PublicCard href="/policies/policies" title="Policies">
          Site-specific policy information configured by admins.
        </PublicCard>
        <PublicCard href="/policies/accessibility" title="Accessibility">
          Accessibility commitments and how to report barriers.
        </PublicCard>
      </PublicGrid>
    </PublicSection>
  </DSProvider>
);

export const RuntimeImagesIntro = () => (
  <DSProvider>
    <PublicSection intro="Discover project runtime images that include ready-to-use software, examples, and files. Choose an image to create a matching project.">
      <p style={{ margin: 0 }}>Loading runtime images…</p>
    </PublicSection>
  </DSProvider>
);

export const DetailsTitleOnly = () => (
  <DSProvider>
    <PublicSection title="Details">
      <p style={{ margin: 0 }}>
        Discover project runtime images that include ready-to-use software,
        examples, and files. Choose an image to create a matching project.
      </p>
    </PublicSection>
  </DSProvider>
);

export const NextStepAriaOnly = () => (
  <DSProvider>
    <PublicSection ariaLabel="Feature operating model next steps">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <LinkButton href="/auth/sign-up">Sign up</LinkButton>
        <LinkButton href="/support">Contact support</LinkButton>
      </div>
    </PublicSection>
  </DSProvider>
);

export const ChildrenOnly = () => (
  <DSProvider>
    <PublicSection>
      <h3 style={{ margin: 0 }}>Available languages</h3>
      <p style={{ margin: 0 }}>
        The localized landing pages summarize the same core product in other
        languages, while the broader public site and main application continue
        to evolve in English first.
      </p>
    </PublicSection>
  </DSProvider>
);
