import {
  getPublicFeaturePage,
  PUBLIC_FEATURE_PAGES,
} from "./public-feature-pages";
import {
  COCALC_AI_SIGN_UP_LABEL,
  getPublicFeatureSignUpLabel,
  isCanonicalPublicSiteHost,
  isCocalcAiLaunchpad,
  isCocalcAiOnlyPublicPath,
  isCocalcAiOnlyPublicSection,
  isLockedDownPublicSiteHost,
  normalizePublicSiteHost,
  PUBLIC_SIGN_UP_LABEL,
} from "./public-site-policy";

test("normalizes public-site hosts", () => {
  expect(normalizePublicSiteHost("https://CoCalc.AI:443/path")).toBe(
    "cocalc.ai",
  );
  expect(normalizePublicSiteHost("[::1]:9100")).toBe("::1");
});

test("distinguishes the canonical, locked-down, and branded hosts", () => {
  expect(isCanonicalPublicSiteHost("cocalc.ai")).toBe(true);
  expect(isCanonicalPublicSiteHost("dev123.cocalc.ai")).toBe(false);
  expect(isLockedDownPublicSiteHost("dev123.cocalc.ai")).toBe(true);
  expect(isLockedDownPublicSiteHost("localhost:9100")).toBe(true);
  expect(isLockedDownPublicSiteHost("university.example.edu")).toBe(false);
});

test("identifies marketing routes reserved for cocalc.ai", () => {
  expect(isCocalcAiOnlyPublicPath("/features/jupyter-notebook")).toBe(true);
  expect(isCocalcAiOnlyPublicPath("/pricing")).toBe(true);
  expect(isCocalcAiOnlyPublicPath("/news")).toBe(false);
  expect(isCocalcAiOnlyPublicPath("/about-face")).toBe(false);
  expect(isCocalcAiOnlyPublicSection("products")).toBe(true);
  expect(isCocalcAiOnlyPublicSection("docs")).toBe(false);
});

test("treats only Launchpad on the canonical host as cocalc.ai", () => {
  // cocalc.ai's /customize reports the Launchpad product.
  expect(
    isCocalcAiLaunchpad({ cocalc_product: "launchpad", dns: "cocalc.ai" }),
  ).toBe(true);
  expect(
    isCocalcAiLaunchpad({ cocalc_product: "launchpad", dns: "CoCalc.AI:443" }),
  ).toBe(true);
  for (const config of [
    { cocalc_product: "launchpad", dns: "compute.example.edu" },
    { cocalc_product: "launchpad", dns: "dev123.cocalc.ai" },
    { cocalc_product: "launchpad" },
    { cocalc_product: "rocket", dns: "cocalc.example.com" },
    { cocalc_product: "rocket", dns: "cocalc.ai" },
    { cocalc_product: "plus", dns: "localhost:5000" },
    { cocalc_product: "plus", dns: "cocalc.ai" },
    { dns: "cocalc.ai" },
    {},
    undefined,
  ]) {
    expect(isCocalcAiLaunchpad(config)).toBe(false);
  }
});

test("shows a feature page's own sign-up label on cocalc.ai only", () => {
  const terminal = getPublicFeaturePage("terminal")!;
  expect(getPublicFeatureSignUpLabel(terminal, true)).toBe(
    COCALC_AI_SIGN_UP_LABEL,
  );
  expect(getPublicFeatureSignUpLabel(terminal, false)).toBe(
    PUBLIC_SIGN_UP_LABEL,
  );
  // A page without a label of its own gets the default on every site.
  const linux = getPublicFeaturePage("linux")!;
  expect(linux.signUpLabel).toBeUndefined();
  expect(getPublicFeatureSignUpLabel(linux, true)).toBe(PUBLIC_SIGN_UP_LABEL);
  expect(getPublicFeatureSignUpLabel(linux, false)).toBe(PUBLIC_SIGN_UP_LABEL);
});

test("gives feature pages no sign-up label but the cocalc.ai one", () => {
  // Other sites never show a page's own label, so any other text would
  // disappear there.
  const labelled = PUBLIC_FEATURE_PAGES.filter((page) => page.signUpLabel);
  expect(labelled.map(({ slug }) => slug)).toContain("terminal");
  for (const page of labelled) {
    expect(page.signUpLabel).toBe(COCALC_AI_SIGN_UP_LABEL);
  }
});
