#!/bin/bash
# Check which keys are not used: i.e. which are in the translated files, but not in the extracted strings.

. ./i18n/bin/common.sh

# Extract keys from the first JSON file and sort them.
# LC_ALL=C is essential: locale collation ignores punctuation, which silently
# desyncs comm on keys mixing "-", "_" and "." and yields false positives.
keys1=$(jq -r 'keys_unsorted[]' i18n/extracted.json | LC_ALL=C sort)

# Extract keys from the second JSON file and sort them
keys2=$(jq -r 'keys_unsorted[]' i18n/trans/de_DE.json | LC_ALL=C sort)

# Compare the sorted keys and find those present in the second file but not in the first
unused=$(LC_ALL=C comm -13 <(echo "$keys1") <(echo "$keys2"))

if [ -z "$1" ]; then
    if [ -z "$unused" ]; then
        echo "No unused keys"
        exit 0
    else
        echo "Unused keys"
        echo "$unused"
        echo ""
        echo "append arg 'delete' to acutally delete these keys."
        exit 1
    fi
fi

if [ "$1" == "delete" ]; then
    check_api_key

    echo "Deleting unused keys from SimpleLocalize..."
    deleted=0
    failed=0
    for key in $unused; do
        if simplelocalize_api DELETE \
            "https://api.simplelocalize.io/api/v1/translation-keys?key=$key" >/dev/null; then
            echo "  deleted '$key'"
            deleted=$((deleted + 1))
        else
            echo "  FAILED  '$key'" >&2
            failed=$((failed + 1))
        fi
    done

    echo
    if [ "$failed" -gt 0 ]; then
        echo "Deleted $deleted key(s), but $failed failed -- see the errors above." >&2
        exit 1
    fi
    echo "Deleted $deleted key(s). Now you have to download and compile again..."
fi
