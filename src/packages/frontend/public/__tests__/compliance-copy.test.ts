/** @jest-environment node */

import { readFileSync } from "fs";
import { join } from "path";

const PUBLIC_ROOT = join(__dirname, "..");

const COMPLIANCE_COPY_CANARIES = {
  "policies/accessibility.tsx": [
    "as WCAG. However, we are committed to do our best to resolve any concrete issues that our customers face.",
    "still do not claim to have AA compliance with WCAG.",
    "SageMathInc_VPAT2.5Rev_WCAG_February2025_December2025.pdf",
    "should not be read as a complete assessment of every current interface.",
  ],
  "policies/dpa.tsx": [
    'This Data Processing Addendum ("<b>DPA</b>") is incorporated into the SageMath, Inc. Terms of Service ("<b>Agreement</b>")',
    "Data is encrypted at rest and in transit using industry-standard protocols.",
    "SageMath, Inc. undergoes regular security assessments and maintains documentation of its security controls (e.g., SOC 2 Type II report).",
    "Pursuant to Article 27 of the GDPR, SageMath, Inc. has appointed the following representatives for data protection matters in the EU and UK:",
    "maintenance of a <b>SOC 2 Type II</b> report satisfies the Controller&apos;s right to audit SageMath, Inc.&apos;s technical and organizational measures.",
  ],
  "policies/ferpa.tsx": [
    "FERPA Compliance Statement",
    "FERPA requires that reasonable measures be taken to ensure the security of personally identifiable information (PII) from student academic records.",
    "SageMath, Inc. will make every effort to comply with FERPA disclosures policies.",
  ],
  "policies/privacy.tsx": [
    "Sagemath has certified to the U.S. Department of Commerce that it adheres to the Swiss-U.S. Data Privacy Framework Principles",
    "Data Privacy Framework (DPF) program, and to view our certification",
    "We implement appropriate technical and organizational measures designed to protect Personal Information against unauthorized access, loss, misuse, alteration, or disclosure.",
    "If we learn of a personal data breach, in accordance with GDPR we will inform the Supervisory Authority within 72 hours.",
    "Sagemath commits to resolve DPF Principles-related complaints about our collection and use of your personal information.",
    "Sagemath commits to cooperate and comply respectively with the advice of the panel established by the EU data protection authorities",
    "Sagemath does not share Personal Information with Third Parties for their own marketing purposes.",
    "mechanisms to verify ongoing compliance with DPF Principles and this Policy.",
  ],
  "policies/terms.tsx": [
    "Subject to your compliance with these Terms, SMI grants you",
    "Attempt to probe, scan or test the vulnerability of any SMI system or network or breach any security or authentication measures without SMI",
    "we have the right to do so for the purpose of operating the Services, to ensure compliance with these Terms, and to comply with applicable law or other legal requirements.",
  ],
  "policies/trust.tsx": [
    "Published trust resources, including SOC 2, GDPR, and Trust Center references.",
    "controls we have in place for security and related Trust Services Criteria. A SOC 2 report describes whether those controls were suitably designed and operating over a defined audit period; the specific criteria and period are described in the current report.",
    "SageMath, Inc. compliance with",
    "GDPR Local",
    "verificationId: 'RNCB5WV'",
  ],
  "pricing/page.tsx": [
    "For teams, courses, labs, and institutions, pricing is usually two decisions: where CoCalc runs, and what purchasing or support wrapper the group needs.",
    "Use site licensing when an organization needs one agreement around procurement, governance, support expectations, rollout, data-location, privacy, or security questions, or deployment rights across CoCalc.ai, Star, Launchpad, or Rocket.",
    "Helpful context: expected users or groups, operating model, procurement timeline, onboarding needs, data-location, privacy, or security questions, and support coordination needs.",
    "Helpful context: product path, expected users or projects, billing timeline, procurement process, and any deployment, privacy, security, data-location, or support constraints.",
  ],
} as const;

function normalizedSource(relativePath: string): string {
  return readFileSync(join(PUBLIC_ROOT, relativePath), "utf8").replace(
    /\s+/g,
    " ",
  );
}

function normalizeCanary(canary: string): string {
  return canary.replace(/\s+/g, " ");
}

describe("public compliance/legal copy canaries", () => {
  for (const [relativePath, canaries] of Object.entries(
    COMPLIANCE_COPY_CANARIES,
  )) {
    it(`pins load-bearing tokens in ${relativePath}`, () => {
      const source = normalizedSource(relativePath);

      for (const canary of canaries) {
        expect(source).toContain(normalizeCanary(canary));
      }
    });
  }
});
