/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export type RootfsProjectPreset = "standard" | "gpu" | "teaching";

export const ROOTFS_PROJECT_PRESET_LABELS: Record<RootfsProjectPreset, string> =
  {
    standard: "Standard",
    gpu: "GPU",
    teaching: "Teaching",
  };

export const ROOTFS_PROJECT_PRESET_TAGS: Record<RootfsProjectPreset, string[]> =
  {
    standard: ["preset:standard", "standard", "base", "cpu"],
    gpu: ["preset:gpu", "gpu", "cuda", "pytorch", "tensorflow"],
    teaching: [
      "preset:teaching",
      "teaching",
      "education",
      "class",
      "course",
      "workshop",
    ],
  };
