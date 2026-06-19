import { DSProvider, PublicCard, PublicGrid } from "@cocalc/frontend";

// PublicGrid — responsive antd Row that wraps each top-level child in its own
// <Col>. `columns` (2 | 3 | 4) + `children` are both required. Children are
// always sibling PublicCard blocks. Real content: policy pairs (2), the /support
// community links (3), and a widest-layout mix (4). antd <Paragraph> swapped for
// plain <p> per preview rules; each card keeps a stable key.

export const TwoColumns = () => (
  <DSProvider>
    <PublicGrid columns={2}>
      <PublicCard href="/policies/imprint" key="/policies/imprint" title="Imprint">
        <p style={{ margin: 0 }}>Site-specific legal imprint information.</p>
      </PublicCard>
      <PublicCard
        href="/policies/policies"
        key="/policies/policies"
        title="Policies"
      >
        <p style={{ margin: 0 }}>
          Site-specific policy information configured by admins.
        </p>
      </PublicCard>
    </PublicGrid>
  </DSProvider>
);

export const ThreeColumns = () => (
  <DSProvider>
    <PublicGrid columns={3}>
      <PublicCard
        href="https://github.com/sagemathinc/cocalc-ai"
        key="https://github.com/sagemathinc/cocalc-ai"
        rel="noreferrer"
        target="_blank"
        title="GitHub source code"
      >
        <p style={{ margin: 0 }}>
          Browse the source, track issues, report bugs, and send pull requests.
        </p>
      </PublicCard>
      <PublicCard
        href="https://www.linkedin.com/company/sagemath-inc./"
        key="https://www.linkedin.com/company/sagemath-inc./"
        rel="noreferrer"
        target="_blank"
        title="LinkedIn"
      >
        <p style={{ margin: 0 }}>
          Follow company news and updates from SageMath, Inc.
        </p>
      </PublicCard>
      <PublicCard
        href="https://twitter.com/cocalc_com"
        key="https://twitter.com/cocalc_com"
        rel="noreferrer"
        target="_blank"
        title="Twitter/X"
      >
        <p style={{ margin: 0 }}>
          Follow public announcements and updates, or tag the team publicly.
        </p>
      </PublicCard>
    </PublicGrid>
  </DSProvider>
);

export const FourColumns = () => (
  <DSProvider>
    <PublicGrid columns={4}>
      <PublicCard
        href="https://github.com/sagemathinc/cocalc-ai"
        key="https://github.com/sagemathinc/cocalc-ai"
        rel="noreferrer"
        target="_blank"
        title="GitHub source code"
      >
        <p style={{ margin: 0 }}>
          Browse the source, track issues, report bugs, and send pull requests.
        </p>
      </PublicCard>
      <PublicCard
        href="https://www.linkedin.com/company/sagemath-inc./"
        key="https://www.linkedin.com/company/sagemath-inc./"
        rel="noreferrer"
        target="_blank"
        title="LinkedIn"
      >
        <p style={{ margin: 0 }}>
          Follow company news and updates from SageMath, Inc.
        </p>
      </PublicCard>
      <PublicCard
        href="https://twitter.com/cocalc_com"
        key="https://twitter.com/cocalc_com"
        rel="noreferrer"
        target="_blank"
        title="Twitter/X"
      >
        <p style={{ margin: 0 }}>
          Follow public announcements and updates, or tag the team publicly.
        </p>
      </PublicCard>
      <PublicCard href="/policies/imprint" key="/policies/imprint" title="Imprint">
        <p style={{ margin: 0 }}>Site-specific legal imprint information.</p>
      </PublicCard>
    </PublicGrid>
  </DSProvider>
);
