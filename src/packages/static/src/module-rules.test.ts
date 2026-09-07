import moduleRules from "./module-rules";

test("minifies only Essential CSS in production", () => {
  const original = process.env.NODE_ENV;
  try {
    for (const mode of ["production", "development"]) {
      process.env.NODE_ENV = mode;
      const rules = moduleRules()!.rules as any[];
      const rule = rules.find((rule) =>
        rule.include?.test("/packages/essential-frontend/dist/styles.css"),
      );
      expect(rule.include.test("/packages/frontend/styles.css")).toBe(false);
      expect(rule.enforce).toBe("pre");
      expect(rule.use).toEqual(
        mode === "production"
          ? [
              {
                loader: "builtin:lightningcss-loader",
                options: { minify: true },
              },
            ]
          : [],
      );
    }
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});
