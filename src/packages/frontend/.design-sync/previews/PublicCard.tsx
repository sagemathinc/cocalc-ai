import { DSProvider, PublicCard } from "@cocalc/frontend";

// PublicCard — the hoverable outlined card whose entire surface is an <a href>.
// `children` + `href` are required; `title` shows the card head; `rel`/`target`
// mark external links. Variant axis = internal vs external link and simple vs
// composed body. Copy/hrefs are the real ones from the policies / support /
// about-team pages (antd <Paragraph> swapped for plain <p> per preview rules).

export const PolicyCard = () => (
  <DSProvider>
    <PublicCard href="/policies/imprint" title="Imprint">
      <p style={{ margin: 0 }}>Site-specific legal imprint information.</p>
    </PublicCard>
  </DSProvider>
);

export const ExternalCommunityCard = () => (
  <DSProvider>
    <PublicCard
      href="https://github.com/sagemathinc/cocalc-ai"
      rel="noreferrer"
      target="_blank"
      title="GitHub source code"
    >
      <p style={{ margin: 0 }}>
        Browse the source, track issues, report bugs, and send pull requests.
      </p>
    </PublicCard>
  </DSProvider>
);

export const TeamMemberCard = () => (
  <DSProvider>
    <PublicCard
      href="/about/team/william-stein"
      title="William Stein, Founder and CEO"
    >
      <p style={{ margin: 0 }}>
        William Stein is the founder of CoCalc and SageMath, Inc. A
        Berkeley-trained mathematician with over 15 years in teaching and
        research, his work in number theory and computational science led him
        from academia to building open tools for technical computing.
      </p>
    </PublicCard>
  </DSProvider>
);
