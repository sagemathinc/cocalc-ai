// Helper to load ESM-only LangChain packages from CJS without triggering require().
export const importLangchain = new Function(
  "p",
  "return import(p)",
) as <T = any>(path: string) => Promise<T>;
