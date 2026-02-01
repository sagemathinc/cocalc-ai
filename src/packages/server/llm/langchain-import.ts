// Helper to load ESM-only LangChain packages from CJS without triggering require().
// Jest does not allow dynamic import callbacks without --experimental-vm-modules,
// so fall back to require there (tests mock these modules anyway).
export const importLangchain = (path: string) => {
  if (process.env.JEST_WORKER_ID != null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return Promise.resolve(require(path));
  }
  return (new Function("p", "return import(p)") as (
    p: string,
  ) => Promise<any>)(path);
};
