export type ProtectedSurface = "home/" | "theme.ts";

export interface ProtectedSurfaceOverride {
  readonly surface: ProtectedSurface;
  readonly reason: string;
  readonly approvedBy: string;
}

export const PROTECTED_SURFACE_OVERRIDES: readonly ProtectedSurfaceOverride[] =
  [
    {
      surface: "home/",
      reason:
        "Blaec-directed round-4 home H1 override; queue item 34, 2026-06-23",
      approvedBy: "Blaec",
    },
    {
      surface: "theme.ts",
      reason: "alias-only, no new hue; Blaec-accepted, 3561f1405c pattern",
      approvedBy: "Blaec",
    },
  ];
