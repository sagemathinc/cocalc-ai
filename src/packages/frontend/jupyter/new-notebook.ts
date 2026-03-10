import getKernelSpec from "@cocalc/frontend/jupyter/kernelspecs";

const DEFAULT_NOTEBOOK_KERNEL: {
  name: string;
  display_name: string;
  language: string;
} = {
  name: "python3",
  display_name: "Python 3 (ipykernel)",
  language: "python",
};

export async function createInitialIpynbContent(
  project_id: string,
  preferredKernel?: string | null,
  fallbackKernel?: {
    name: string;
    display_name: string;
    language: string;
  },
): Promise<string> {
  let kernelspec = preferredKernel
    ? {
        ...(fallbackKernel ?? DEFAULT_NOTEBOOK_KERNEL),
        name: preferredKernel,
      }
    : { ...(fallbackKernel ?? DEFAULT_NOTEBOOK_KERNEL) };
  try {
    const kernels = await getKernelSpec({ project_id });
    const match =
      kernels.find((spec) => spec.name === preferredKernel) ??
      kernels.find((spec) => spec.name === DEFAULT_NOTEBOOK_KERNEL.name) ??
      kernels[0];
    if (match != null) {
      kernelspec = {
        name: match.name,
        display_name: match.display_name,
        language: match.language,
      };
    }
  } catch {
    // If kernel discovery fails, still create a valid Python notebook.
  }
  return JSON.stringify(
    {
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: [],
        },
      ],
      metadata: {
        kernelspec,
        language_info: {
          name: kernelspec.language,
        },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    2,
  );
}
