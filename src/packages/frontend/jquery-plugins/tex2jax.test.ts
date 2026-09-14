import { tex2jax } from "./tex2jax";

it("preprocesses math and escaped dollars without global jQuery", () => {
  const previous = globalThis.$;
  delete (globalThis as any).$;
  const div = document.createElement("div");
  div.textContent = "Cost: \\$5. Formula: $x+1$.";
  try {
    tex2jax.PreProcess(div);
    expect(div.querySelector('script[type="math/tex"]')?.textContent).toBe(
      "x+1",
    );
    expect(div.textContent).toContain("$5");
  } finally {
    globalThis.$ = previous;
  }
});
