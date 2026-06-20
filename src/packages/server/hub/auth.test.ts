// just a sanity check for dot-object

import dot from "dot-object";

import { assertExclusiveDomainsUnique } from "./auth";

describe("dot-object", () => {
  const o = {
    a: {
      b: "foo",
      "cd.1.2": "bar",
    },
  };

  it("default delimiter", () => {
    const v = dot.pick("a.b", o);
    expect(v).toEqual("foo");
  });

  it("custom delimiter", () => {
    const d = new dot("->");
    const v = d.pick("a->cd.1.2", o);
    expect(v).toEqual("bar");
  });
});

describe("assertExclusiveDomainsUnique", () => {
  it("rejects duplicate exclusive domains after normalization", () => {
    expect(() =>
      assertExclusiveDomainsUnique({
        google: {
          strategy: "google",
          conf: { type: "oidc" },
          info: { exclusive_domains: ["Example.edu"] },
        },
        saml: {
          strategy: "saml",
          conf: { type: "saml" },
          info: { exclusive_domains: [" example.edu "] },
        },
      } as any),
    ).toThrow(
      "exclusive domain 'example.edu' defined by google and saml: they must be unique",
    );
  });
});
