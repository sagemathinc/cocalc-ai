/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Tint the browser tab's icon with the current thread's color, so the right
// tab is findable among many CoCalc tabs. Restores the site icon when unset.

let original: string | undefined;
let current: string | undefined;
let generation = 0;

function iconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>("link[rel~='icon']");
}

export function setBrowserTabAccent(color?: string): void {
  if (typeof document === "undefined") return;
  if (color === current) return;
  current = color;
  const link = iconLink();
  if (link && original == null) original = link.href;
  const mine = ++generation;
  if (!color) {
    if (link && original) link.href = original;
    return;
  }
  if (!original) return;
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => {
    if (mine !== generation) return;
    try {
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0, size, size);
      context.beginPath();
      context.arc(size * 0.76, size * 0.76, size * 0.22, 0, 2 * Math.PI);
      context.fillStyle = color;
      context.fill();
      context.lineWidth = size * 0.06;
      context.strokeStyle = "white";
      context.stroke();
      const target = iconLink();
      if (target) target.href = canvas.toDataURL("image/png");
    } catch {
      // A tainted canvas or missing 2D context: keep the site icon.
    }
  };
  image.src = original;
}
