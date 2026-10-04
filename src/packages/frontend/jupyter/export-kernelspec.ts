import type { KernelSpec } from "@cocalc/jupyter/ipynb/parse";

// Rendering saved outputs does not require a running kernel or its catalog.
export function getExportKernelSpec(
  kernel: string | null | undefined,
  info: KernelSpec | undefined,
  metadata: unknown,
): KernelSpec {
  if (!kernel) {
    return { name: "", display_name: "No Kernel" };
  }
  if (info?.name === kernel) {
    return info;
  }
  const saved =
    metadata != null && typeof metadata === "object"
      ? (metadata as { kernelspec?: unknown }).kernelspec
      : undefined;
  const spec: KernelSpec = { name: kernel, display_name: kernel };
  if (saved != null && typeof saved === "object") {
    const { name, display_name, language } = saved as Record<string, unknown>;
    // Never attach stale metadata from a different selected kernel.
    if (name === kernel) {
      if (typeof display_name === "string" && display_name.trim()) {
        spec.display_name = display_name;
      }
      if (typeof language === "string" && language.trim()) {
        spec.language = language;
      }
    }
  }
  return spec;
}
