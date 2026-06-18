import { readFileSync } from "fs";
import { join } from "path";

const frontendRoot = process.cwd();
const repoRoot = join(frontendRoot, "../../..");
const srcRoot = join(frontendRoot, "../..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function readSrcFile(path: string): string {
  return readFileSync(join(srcRoot, path), "utf8");
}

describe("public-site agent workflow documentation", () => {
  const auditDoc = readRepoFile("docs/public-site-cohesion-audit.md");
  const landingAgentAudit = readSrcFile(
    ".agents/landing-page-agent-operating-audit.md",
  );
  const multiAgentGithubModel = readSrcFile(
    ".agents/multi-agent-github-operating-model.md",
  );
  const repoAgentInstructions = readRepoFile("AGENTS.md");
  const promptLog = readSrcFile(".agents/public-site-audit-prompt-log.md");
  const publicSiteSkill = readRepoFile(
    ".agents/skills/public-site-landing-page/SKILL.md",
  );

  it("keeps the reusable operating model and check matrix in the audit ledger", () => {
    expect(auditDoc).toContain("### PSL-2026-06-17-006");
    expect(auditDoc).toContain("### PSL-2026-06-17-007");
    expect(auditDoc).toContain("## Agentic Public-Site Operating Model");
    expect(auditDoc).toContain("## Agentic Public-Site Check Matrix");
    expect(auditDoc).toContain("### Automate");
    expect(auditDoc).toContain("### Manual Browser QA");
    expect(auditDoc).toContain("### Human Product Judgment");
  });

  it("records which process checks are automated, manual, or human-owned", () => {
    expect(auditDoc).toContain("CTA route discipline");
    expect(auditDoc).toContain("Prompt and ledger continuity");
    expect(auditDoc).toContain("Rendered layout baselines");
    expect(auditDoc).toContain("Does the page feel visually crowded");
    expect(auditDoc).toContain("Human review should produce a ledger entry");
  });

  it("keeps prompt-log continuity and artifact hygiene explicit", () => {
    expect(promptLog).toContain("## Operating Standard");
    expect(promptLog).toContain("## Prompt Backlog");
    expect(promptLog).toContain("PSL-");
    expect(promptLog).toContain("next recommended prompt");
    expect(promptLog).toContain("scratch QA artifacts outside the repository");
    expect(promptLog).toContain("Do not paste raw chat transcripts");
    expect(promptLog).toContain("Reusable Browser QA Harness");
  });

  it("keeps the Landing Page Agent operating audit and skill discoverable", () => {
    expect(auditDoc).toContain("### PSL-2026-06-17-011");
    expect(auditDoc).toContain("KI-2026-06-17-F");
    expect(promptLog).toContain("public-site-landing-page/SKILL.md");

    expect(landingAgentAudit).toContain("## Operating Failure Register");
    expect(landingAgentAudit).toContain("LPA-001");
    expect(landingAgentAudit).toContain("change budget");
    expect(landingAgentAudit).toContain("visitor question");
    expect(landingAgentAudit).toContain("human product judgment");

    expect(publicSiteSkill).toContain("name: public-site-landing-page");
    expect(publicSiteSkill).toContain(
      "State the page's primary visitor question",
    );
    expect(publicSiteSkill).toContain("Set a small change budget");
    expect(publicSiteSkill).toContain("Do not flatten route-specific evidence");
    expect(publicSiteSkill).toContain("Store browser QA artifacts only under");
  });

  it("keeps worktree and preview ownership rules discoverable", () => {
    expect(publicSiteSkill).toContain(
      "src/.agents/multi-agent-github-operating-model.md",
    );
    expect(publicSiteSkill).toContain("Preview ownership");
    expect(publicSiteSkill).toContain("readlink /proc/<hub-pid>/cwd");

    expect(multiAgentGithubModel).toContain("One active workstream");
    expect(multiAgentGithubModel).toContain("blaec.cocalc.ai");
    expect(multiAgentGithubModel).toContain("/home/user/cocalc-ai-synthesis");
    expect(multiAgentGithubModel).toContain("blaec-synthesis-2026-06-18");
    expect(multiAgentGithubModel).toContain("Vibe Feedback Translation");
    expect(multiAgentGithubModel).toContain("Prompt Contract");
    expect(multiAgentGithubModel).toContain("Do not commit them");
    expect(multiAgentGithubModel).toContain(
      "Repository And Agent File Architecture",
    );

    expect(repoAgentInstructions).toContain("Agent File Architecture Map");
    expect(repoAgentInstructions).toContain(
      "src/.agents/multi-agent-github-operating-model.md",
    );
    expect(repoAgentInstructions).toContain("/home/user/cocalc-ai-synthesis");
  });
});
