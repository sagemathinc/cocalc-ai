export type ProtectedSurface = "home/" | "protected-gate" | "theme.ts";

export interface ProtectedSurfaceOverride {
  readonly surface: ProtectedSurface;
  readonly reason: string;
  readonly approvedBy: string;
}

export interface ProtectedSurfaceBaseline {
  readonly surface: ProtectedSurface;
  readonly path: string;
  readonly sha256: string;
  readonly reason: string;
  readonly approvedBy: string;
}

export const PROTECTED_SURFACE_OVERRIDES: readonly ProtectedSurfaceOverride[] =
  [];

export const PROTECTED_SURFACE_BASELINES: readonly ProtectedSurfaceBaseline[] =
  [
    {
      surface: "home/",
      path: "public/home/__tests__/app.test.tsx",
      sha256:
        "7c744614c27dd44844f43a6f5b2636f9eaf6d83112bba059642d04ac29c66656",
      reason:
        "Home differentiator modal CTA route test accepted; future edits need a fresh override",
      approvedBy: "Blaec",
    },
    {
      surface: "home/",
      path: "public/home/__tests__/bootstrap.test.ts",
      sha256:
        "2433737c27899d1ef02c7dc8a22aff7c81f86ecd691b4dcd8e807b6a666f9392",
      reason:
        "current committed home bootstrap tests accepted; future edits need a fresh override",
      approvedBy: "Blaec",
    },
    {
      surface: "home/",
      path: "public/home/__tests__/visual-quality.test.tsx",
      sha256:
        "0421916f68856dac21479c0a7ef9f21a2dd72d8e77d7a3dd9a0aa3a628c6bcd0",
      reason:
        "Home H1 research teams visual tests accepted; future edits need a fresh override",
      approvedBy: "Blaec",
    },
    {
      surface: "home/",
      path: "public/home/app.tsx",
      sha256:
        "61cd6cbf155cd0299c0c7ef938946c8553effa781395ff740a29de6f98c48b7f",
      reason:
        "Home differentiator modal CTA routes accepted; future edits need a fresh override",
      approvedBy: "Blaec",
    },
    {
      surface: "theme.ts",
      path: "public/theme.ts",
      sha256:
        "aabfd226fcb1643f826d05da6662cd7d65dc9626d0d4c2aacd16f9eddd517e6c",
      reason:
        "current committed theme aliases accepted; future edits need a fresh override",
      approvedBy: "Blaec",
    },
    {
      surface: "protected-gate",
      path: "public/__tests__/protected-overrides.ts",
      sha256:
        "f7922621339643c2291ea13e96f563904ee720af03e720635d2ced35a1a576d4",
      reason:
        "Home differentiator modal CTA route baseline accepted; future edits need a fresh override",
      approvedBy: "Blaec",
    },
    {
      surface: "protected-gate",
      path: "public/__tests__/protected-surfaces.test.ts",
      sha256:
        "908ffe27d0bfaf91813763cfa8851f52146a11912dbf89a9e706f9a35a179e19",
      reason:
        "current committed protected-surface gate test accepted; future edits need a fresh override",
      approvedBy: "Blaec",
    },
  ];
