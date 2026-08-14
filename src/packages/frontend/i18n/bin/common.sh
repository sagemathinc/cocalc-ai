LANGS="de_DE zh_CN es_ES es_PV fr_FR nl_NL ru_RU it_IT ja_JP pt_PT pt_BR ko_KR pl_PL tr_TR he_IL hi_IN hu_HU ar_EG"

check_api_key() {
    if [ -z "${SIMPLELOCALIZE_KEY}" ]; then
        echo "Error: SIMPLELOCALIZE_KEY is not set or is empty. Please provide a valid API key." >&2
        echo "Hint: the key lives outside the repo; source the file that exports it." >&2
        exit 1
    fi
}

# Call the SimpleLocalize API and fail loudly instead of silently continuing.
#
# curl exits 0 for HTTP error responses unless asked otherwise, so a plain
# `curl -s ...` treats "503 Service Unavailable" and "204 Deleted" alike. That
# turned an outage into a green "Done!" -- see the 521s during the 2026-08-13
# outage, where every delete reported success and deleted nothing.
#
# Longest we wait for a single response, in seconds. Callers set this higher
# for endpoints that do real work before replying -- auto-translate fans out
# over every language and takes minutes, so a short cap turns a healthy run
# into a spurious timeout. The connect timeout stays short either way, so an
# unreachable host still fails fast.
SIMPLELOCALIZE_MAX_TIME="${SIMPLELOCALIZE_MAX_TIME:-60}"
SIMPLELOCALIZE_CONNECT_TIMEOUT="${SIMPLELOCALIZE_CONNECT_TIMEOUT:-20}"

# Usage: simplelocalize_api <METHOD> <URL> [extra curl args...]
# Writes the response body to stdout; returns non-zero and explains on failure.
simplelocalize_api() {
    local method="$1" url="$2"
    shift 2

    local response status body
    if ! response=$(curl -sS \
        --connect-timeout "$SIMPLELOCALIZE_CONNECT_TIMEOUT" \
        --max-time "$SIMPLELOCALIZE_MAX_TIME" --location \
        --write-out '\n%{http_code}' \
        --request "$method" "$url" \
        --header "X-SimpleLocalize-Token: $SIMPLELOCALIZE_KEY" \
        "$@" 2>&1); then
        echo "Error: could not reach $url" >&2
        echo "$response" >&2
        return 1
    fi

    status="${response##*$'\n'}"
    body="${response%$'\n'*}"

    if ! [ "$status" -ge 200 ] 2>/dev/null || [ "$status" -ge 300 ]; then
        echo "Error: $method $url returned HTTP $status" >&2
        [ -n "$body" ] && echo "$body" >&2
        case "$status" in
        000) echo "Hint: no HTTP response at all -- the request timed out (${SIMPLELOCALIZE_MAX_TIME}s) or the network/DNS failed. If the endpoint is simply slow, raise SIMPLELOCALIZE_MAX_TIME." >&2 ;;
        401 | 403) echo "Hint: SIMPLELOCALIZE_KEY is set but was rejected. Wrong or expired key?" >&2 ;;
        429) echo "Hint: rate limited. Wait a bit and retry." >&2 ;;
        52*) echo "Hint: HTTP $status is a Cloudflare origin error. The SimpleLocalize API is down; nothing is wrong on your side. Retry later." >&2 ;;
        esac
        return 1
    fi

    printf '%s' "$body"
}
