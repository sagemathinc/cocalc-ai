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
        "7977c0830962012d1cc80d9972ce2b5c067d60803960f08e164292eaa9f637bb",
      reason:
        "current committed home app smoke tests accepted; future edits need a fresh override",
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
        "3707ea142b2f45f0bcedf156e9beae2dd33bc615655dda58c93f53d44fa372ce",
      reason:
        "current committed home visual tests accepted; future edits need a fresh override",
      approvedBy: "Blaec",
    },
    {
      surface: "home/",
      path: "public/home/app.tsx",
      sha256:
        "b5648a3813e5513ec6b683a4c0df4204c5c078d7475462d9aabb85e02c051024",
      reason:
        "current committed home page accepted after Blaec-directed H1 correction; future edits need a fresh override",
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
        "75c31cdca0d6959da94cc4009a50e7187c7a31d9c5ee069ac1af559c2c17860b",
      reason:
        "current committed protected-surface override manifest accepted; future edits need a fresh override",
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
