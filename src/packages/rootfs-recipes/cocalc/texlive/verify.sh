set -Eeuo pipefail

# Merge stderr into stdout. The build log is a single stream, and stdout is
# block-buffered when piped while stderr is not, so keeping them separate
# reorders failure messages away from the step they belong to.
exec 2>&1

# Report which command failed. Without this, any bare `test` or unchecked
# command aborts under `set -e` with no output at all, which turns a one-line
# problem into a guessing game against a multi-hour build.
trap 'echo ">> verify FAILED at line $LINENO: $BASH_COMMAND"' ERR

# Verify the TeX Live tree itself. Document-level compile tests that need R,
# Quarto, or Python live in the image spec's top-level verify block, since they
# depend on steps this module knows nothing about.

year="${YEAR:-2026}"
fontconfig="${FONTCONFIG:-true}"
disable_apt_texlive="${DISABLE_APT_TEXLIVE:-true}"
purge_apt_texlive="${PURGE_APT_TEXLIVE:-true}"

texdir="/usr/local/texlive/$year"

echo ">> verifying TeX Live $year"

test -d "$texdir" || { echo "no TeX Live tree at $texdir" >&2; exit 1; }
echo ">> stage: binaries on PATH"

tlmgr --version

# texcount backs the word count frame in CoCalc's LaTeX editor; it is not part
# of every TeX Live scheme, so its absence is a real gap rather than cosmetic.
for exe in tex latex pdflatex xelatex lualatex latexmk bibtex biber makeindex kpsewhich texcount; do
  command -v "$exe" >/dev/null || { echo "missing on PATH: $exe" >&2; exit 1; }
done

echo ">> stage: binaries resolve under prefix"

# The binaries must come from the upstream tree, not a leftover Debian install.
tex_path="$(command -v tex)" || { echo "tex is not on PATH" >&2; exit 1; }
resolved="$(readlink -f "$tex_path")" || {
  echo "cannot resolve $tex_path" >&2
  exit 1
}
case "$resolved" in
  "$texdir"/*) ;;
  *) echo "tex resolves to $resolved, expected a path under $texdir" >&2; exit 1 ;;
esac

echo ">> stage: apt shim and leftovers"

installed_apt_texlive() {
  dpkg-query -W -f '${Package} ${Status}\n' 'texlive*' 2>/dev/null \
    | awk '$NF == "installed" { print $1 }' \
    | grep -vx 'texlive-local' || true
}

if [ "$disable_apt_texlive" = "true" ] || [ "$disable_apt_texlive" = "1" ]; then
  # Command substitution plus case rather than a pipe into grep -q, for the
  # same pipefail reason documented at the fontconfig check below.
  shim_status="$(dpkg-query -W -f '${Status}' texlive-local 2>/dev/null || true)"
  case "$shim_status" in
    *"ok installed"*) ;;
    *)
      echo "the texlive-local APT shim is not installed (status: ${shim_status:-none})" >&2
      exit 1
      ;;
  esac
fi

if [ "$purge_apt_texlive" = "true" ] || [ "$purge_apt_texlive" = "1" ]; then
  leftover="$(installed_apt_texlive)"
  if [ -n "$leftover" ]; then
    echo "Debian TeX Live packages are still installed:" $leftover >&2
    exit 1
  fi
fi

echo ">> stage: pythontex"

# PythonTeX ships with TeX Live; the LaTeX editor invokes pythontex3 by
# preference and falls back to pythontex.
command -v pythontex3 >/dev/null || command -v pythontex >/dev/null || {
  echo "neither pythontex3 nor pythontex is on PATH" >&2
  exit 1
}

echo ">> stage: style files"

# Style files used by the compile tests further down the pipeline.
for sty in pythontex.sty dsfont.sty graphicx.sty amsmath.sty babel.sty; do
  kpsewhich "$sty" >/dev/null || { echo "kpsewhich cannot find $sty" >&2; exit 1; }
done

echo ">> stage: pdftotext"

# pdftotext is what makes the document compile tests meaningful: latexmk runs
# with -f -interaction=nonstopmode and emits a PDF even when a preprocessing
# step silently did nothing, so asserting on PDF *content* is the only real
# check available later.
command -v pdftotext >/dev/null || { echo "pdftotext missing (poppler-utils)" >&2; exit 1; }

echo ">> stage: smoke compile"

# Minimal end-to-end compile, no external engines involved.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/smoke.tex" <<'TEXLIVE_SMOKE_TEX'
\documentclass{article}
\usepackage{amsmath}
\begin{document}
Smoke test: $e^{i\pi} + 1 = 0$.
\end{document}
TEXLIVE_SMOKE_TEX

(cd "$tmp" && latexmk -pdf -f -g -interaction=nonstopmode smoke.tex >/dev/null 2>&1) || true
test -s "$tmp/smoke.pdf" || { echo "latexmk produced no smoke.pdf" >&2; exit 1; }
pdftotext "$tmp/smoke.pdf" "$tmp/smoke.txt"
grep -q "Smoke test" "$tmp/smoke.txt" || {
  echo "smoke.pdf does not contain the expected text; extracted:" >&2
  cat "$tmp/smoke.txt" >&2
  exit 1
}

echo ">> stage: fontconfig"

if [ "${fontconfig}" = "true" ] || [ "${fontconfig}" = "1" ]; then
  conf="/etc/fonts/conf.d/09-texlive.conf"
  test -r "$conf" || { echo "missing or unreadable: $conf" >&2; exit 1; }

  # Materialize the listing first and grep the file, never `fc-list | grep -q`.
  # Under `set -o pipefail`, grep -q exits on its first match and closes the
  # pipe, fc-list dies of SIGPIPE, and the pipeline reports failure precisely
  # when the font *was* found -- inverting the check. The same applies to any
  # consumer that exits early, such as head.
  fc-list > "$tmp/fc-list.txt"

  if ! grep -qi "latinmodern\|Latin Modern" "$tmp/fc-list.txt"; then
    echo "fontconfig does not see the TeX Live Latin Modern fonts" >&2
    echo "fc-list reported $(wc -l < "$tmp/fc-list.txt") fonts; sample:" >&2
    head -20 "$tmp/fc-list.txt" >&2
    exit 1
  fi

  # The listing must actually come from the upstream tree, not only from
  # system font packages that happen to ship similar families.
  if ! grep -q "^$texdir/" "$tmp/fc-list.txt"; then
    echo "fc-list sees no fonts under $texdir" >&2
    exit 1
  fi
fi

echo ">> TeX Live $year verified"
