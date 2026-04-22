#!/usr/bin/env bash
. ./i18n/bin/common.sh

check_api_key

# Each language is downloaded into a separate file and compiled – this allows for dynamic imports.
node ./i18n/bin/run-for-each-lang.js \
  --label download \
  --item-label "calling download" \
  --langs "$LANGS" \
  -- simplelocalize download \
    --apiKey "$SIMPLELOCALIZE_KEY" \
    --downloadPath "./i18n/trans/{lang}.json" \
    --downloadFormat single-language-json \
    "--languageKey={lang}"
