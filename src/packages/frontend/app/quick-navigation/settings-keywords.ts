/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { IntlShape, MessageDescriptor } from "react-intl";

// Read the same labels as the controls, without rendering/mounting settings
// pages. Existing rich-text descriptors contribute text, not their markup.
export function settingsKeywords(
  intl: Pick<IntlShape, "formatMessage">,
  controls: readonly (MessageDescriptor | string)[],
): string {
  const text = controls
    .map((label) =>
      typeof label === "string"
        ? label
        : intl.formatMessage(label, undefined, { ignoreTag: true }),
    )
    .join(" ");
  const words =
    text
      .replace(/<[^>]*>/g, " ")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  // Keep function words: queries can contain the full visible control label.
  return [...new Set(words)].join(" ");
}
