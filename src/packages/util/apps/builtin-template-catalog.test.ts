import catalog from "./builtin-template-catalog";

function expectSystemInstallCommandUsesSudo(command: string, label: string) {
  for (const segment of command.split("&&")) {
    const trimmed = segment.trim();
    if (/^(apt|apt-get)\b/.test(trimmed)) {
      throw new Error(`${label} must use sudo for apt: ${trimmed}`);
    }
    if (
      /^python3\s+-m\s+pip\s+install\b/.test(trimmed) &&
      trimmed.includes("--break-system-packages")
    ) {
      throw new Error(
        `${label} must use sudo for system pip installs: ${trimmed}`,
      );
    }
  }
}

describe("builtin app template catalog", () => {
  it("uses sudo for curated system install recipes", () => {
    for (const template of catalog.templates) {
      if (template.install?.command != null) {
        expectSystemInstallCommandUsesSudo(
          template.install.command,
          `${template.id} install command`,
        );
      }

      for (const recipe of template.install?.recipes ?? []) {
        for (const command of recipe.commands) {
          expectSystemInstallCommandUsesSudo(
            command,
            `${template.id} ${recipe.id} recipe command`,
          );
        }
      }
    }
  });
});
