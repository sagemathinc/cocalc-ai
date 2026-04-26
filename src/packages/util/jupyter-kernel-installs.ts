/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface JupyterKernelInstallSpec {
  key: string;
  label: string;
  requestedKernel: string;
  description: string;
  probeSummary: string;
  installHint?: string;
}

export const POPULAR_JUPYTER_KERNEL_SPECS: readonly JupyterKernelInstallSpec[] =
  [
    {
      key: "python3",
      label: "Python 3 (ipykernel)",
      requestedKernel: "python3",
      description: "General-purpose Python notebooks using ipykernel.",
      probeSummary:
        "command -v python3 && python3 -m ipykernel --version && jupyter kernelspec list",
      installHint:
        'python3 -m pip install --user ipykernel\npython3 -m ipykernel install --user --name python3 --display-name "Python 3 (ipykernel)"',
    },
    {
      key: "bash",
      label: "Bash",
      requestedKernel: "bash",
      description: "Shell commands and scripts inside notebook cells.",
      probeSummary:
        "command -v python3 && python3 -c 'import bash_kernel' && jupyter kernelspec list",
      installHint:
        "python3 -m pip install --user bash_kernel\npython3 -m bash_kernel.install --user",
    },
    {
      key: "ir",
      label: "R (IRkernel)",
      requestedKernel: "ir",
      description: "Statistical computing in R through IRkernel.",
      probeSummary:
        "command -v R && R -q -e 'library(IRkernel)' && jupyter kernelspec list",
      installHint:
        'R -q -e \'install.packages("IRkernel", repos="https://cloud.r-project.org"); IRkernel::installspec(user = TRUE)\'',
    },
    {
      key: "julia",
      label: "Julia (IJulia)",
      requestedKernel: "julia",
      description: "Julia notebooks provided through the IJulia package.",
      probeSummary:
        "command -v julia && julia -e 'using IJulia' && jupyter kernelspec list",
      installHint: "julia -e 'using Pkg; Pkg.add(\"IJulia\"); using IJulia'",
    },
  ] as const;

export function buildJupyterKernelAgentPrompt(opts: {
  notebookPath: string;
  requestedKernel?: string;
  spec?: JupyterKernelInstallSpec;
}): string {
  const requested =
    `${opts.spec?.requestedKernel ?? opts.requestedKernel ?? ""}`.trim();
  const label = `${(opts.spec?.label ?? requested) || "Jupyter kernel"}`.trim();
  const parts = [
    requested
      ? `Install or enable the Jupyter kernel "${requested}" (${label}) for this notebook if possible.`
      : "Install or enable a suitable Jupyter kernel for this notebook if possible.",
    `Notebook path: ${opts.notebookPath}`,
    `CoCalc discovers kernels from the standard Jupyter kernelspec search paths, roughly equivalent to:\n\njupyter kernelspec list\njupyter --paths --json`,
  ];
  if (opts.spec?.probeSummary) {
    parts.push(`Relevant checks:\n${opts.spec.probeSummary}`);
  }
  if (opts.spec?.installHint) {
    parts.push(`Install hint:\n${opts.spec.installHint}`);
  }
  parts.push(
    requested
      ? `After making changes, verify that a matching kernelspec for ${label} appears in the Jupyter kernelspec list, or explain clearly why it still cannot be provided.`
      : "After making changes, verify that at least one usable kernelspec appears in the Jupyter kernelspec list, or explain clearly why no kernel can be provided.",
  );
  return parts.join("\n\n");
}
