export type ProtectedSurface = "home/" | "theme.ts";

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
  [
    {
      surface: "home/",
      reason:
        "Blaec-directed home H1 micro-correction; queue item 45, 2026-06-23",
      approvedBy: "Blaec",
    },
  ];

export const PROTECTED_SURFACE_BASELINES: readonly ProtectedSurfaceBaseline[] =
  [
    {
      surface: "theme.ts",
      path: "public/theme.ts",
      sha256:
        "aabfd226fcb1643f826d05da6662cd7d65dc9626d0d4c2aacd16f9eddd517e6c",
      reason:
        "current committed theme aliases accepted; future edits need a fresh override",
      approvedBy: "Blaec",
    },
  ];
