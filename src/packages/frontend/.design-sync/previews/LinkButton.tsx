import { DSProvider, LinkButton } from "@cocalc/frontend";

// LinkButton — the flush-left antd link Button (type="link", paddingInline:0)
// used in cross-link rows at the foot of product/feature pages. Both props
// required: `href` (string) + `children` (the label text). Real pages compute
// href via helpers (appPath/GUIDE_BASE/supportHref); here we substitute the
// literal paths the helpers resolve to.

export const CompareFit = () => (
  <DSProvider>
    <LinkButton href="/features/compare">Compare CoCalc fit</LinkButton>
  </DSProvider>
);

export const PricingAndLicensing = () => (
  <DSProvider>
    <LinkButton href="/pricing">Pricing and licensing</LinkButton>
  </DSProvider>
);

export const ReadLatexGuide = () => (
  <DSProvider>
    <LinkButton href="https://doc.cocalc.com/cocalc-for-latex/">
      Read the LaTeX guide
    </LinkButton>
  </DSProvider>
);

export const AskAboutAiWorkflows = () => (
  <DSProvider>
    <LinkButton href="/support">Ask about AI workflows</LinkButton>
  </DSProvider>
);
