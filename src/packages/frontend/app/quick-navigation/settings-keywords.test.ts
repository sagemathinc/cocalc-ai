import { createIntl, createIntlCache } from "react-intl";
import {
  FONT_SIZE_LABEL,
  EDITOR_SETTINGS_CHECKBOXES,
} from "@cocalc/frontend/account/editor-settings/labels";
import { settingsKeywords } from "./settings-keywords";

const intl = createIntl({ locale: "en", messages: {} }, createIntlCache());
it("strips label markup, folds accents, and removes duplicate words", () => {
  expect(
    settingsKeywords(intl, [
      "<strong>Font size</strong>",
      "font SIZE",
      "Éditeur",
    ]),
  ).toBe("font size editeur");
});
it("uses the control's current translation and preserves words in full-label queries", () => {
  const translated = createIntl(
    { locale: "es", messages: { [FONT_SIZE_LABEL.id]: "Tamaño de fuente" } },
    createIntlCache(),
  );
  expect(settingsKeywords(translated, [FONT_SIZE_LABEL])).toBe(
    "tamano de fuente",
  );
  const keywords = settingsKeywords(intl, [
    EDITOR_SETTINGS_CHECKBOXES.disable_markdown_codebar,
  ]);
  expect(keywords).toContain("markdown code bar");
  expect(keywords).not.toContain("strong");
});
