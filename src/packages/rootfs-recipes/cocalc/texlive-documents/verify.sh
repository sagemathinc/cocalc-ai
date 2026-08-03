set -Eeuo pipefail

# Merge stderr into stdout. The build log is a single stream, and stdout is
# block-buffered when piped while stderr is not, so keeping them separate
# reorders failure messages away from the step they belong to.
exec 2>&1

# Report which command failed; a bare command aborting under `set -e`
# otherwise produces no output at all.
trap 'echo "verify: FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

# Compile one representative document per supported format, using the same
# commands CoCalc's editors issue, and assert on rendered *content* rather than
# mere file existence.
#
# Why content: latexmk runs with -f -interaction=nonstopmode and emits a PDF
# even when a preprocessing step silently did nothing. A pythontex failure
# yields a PDF with unexpanded macros and a zero exit status from the final
# latexmk, so `test -f out.pdf` passes on a broken stack. Every test below
# therefore embeds a marker whose value only the engine under test can compute,
# and greps the rendered output for that value.
#
# The computed values are deliberately wide (123456789 rather than, say, 6).
# Matching happens after all whitespace is stripped, so the text following a
# marker runs straight into it; a short value could be satisfied by whatever
# happens to come next and the assertion would pass on an unsubstituted PDF.
#
# Frontmatter in the .rmd/.qmd fixtures selects PDF output on purpose. CoCalc
# passes `output_format = NULL` to rmarkdown::render and omits `--to` from
# quarto render, so the document decides; choosing PDF keeps the commands
# identical to production while still exercising the LaTeX bridge.

wordcount_enabled="${WORDCOUNT:-true}"
pythontex_enabled="${PYTHONTEX:-true}"
knitr_enabled="${KNITR:-true}"
rmarkdown_enabled="${RMARKDOWN:-true}"
quarto_enabled="${QUARTO:-true}"

is_true() {
  case "$1" in
    true|True|TRUE|1|yes) return 0 ;;
    *) return 1 ;;
  esac
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

# The exact latexmk invocation from packages/frontend/frame-editors/latex-editor
# (build_command in latexmk.ts), minus -output-directory, which CoCalc also
# disables whenever pythontex or sagetex is detected.
LATEXMK="latexmk -pdf -f -g -bibtex -deps -synctex=1 -interaction=nonstopmode"

# Strip all whitespace before matching: pdftotext line-wrapping is free to put a
# marker and its value on separate lines, which would defeat a spaced pattern.
pdftext() {
  pdftotext "$1" - 2>/dev/null | tr -d '[:space:]'
}

expect_in_pdf() {
  local pdf="$1" needle="$2" what="$3"
  local text
  text="$(pdftext "$pdf")"
  case "$text" in
    *"$needle"*) ;;
    *)
      echo "$what: expected '$needle' in $pdf" >&2
      echo "extracted text was: $text" >&2
      return 1
      ;;
  esac
}

# --------------------------------------------------------------------------
# Word count: texcount, mirroring count_words() in latex-editor/count_words.ts.
#
# CoCalc runs `texcount <file>` in the file's directory with err_on_exit false
# and puts the raw stdout into the word count frame, so the contract is simply
# a parseable summary on stdout. The editor has a dedicated error path for this
# tool being absent, which makes it worth asserting rather than assuming.
#
# The counts are asserted as positive rather than exact: texcount's rules for
# what constitutes a word have shifted between releases, and pinning a number
# would turn a harmless upstream change into a failed monthly build.
# --------------------------------------------------------------------------
if is_true "$wordcount_enabled"; then
  echo ">> word count: texcount"
  cat > wordcount.tex <<'COCALC_FIXTURE_WORDCOUNT'
\documentclass{article}
\begin{document}
\section{Introduction}
alpha bravo charlie delta echo foxtrot golf hotel india juliett
\end{document}
COCALC_FIXTURE_WORDCOUNT

  texcount wordcount.tex > wordcount.out 2>&1
  grep -qE "Words in text: [1-9][0-9]*" wordcount.out || {
    echo "texcount reported no words in text" >&2
    cat wordcount.out >&2
    exit 1
  }
  grep -qE "Words in headers: [1-9][0-9]*" wordcount.out || {
    echo "texcount reported no words in headers" >&2
    cat wordcount.out >&2
    exit 1
  }
  echo ">> word count OK"
fi

# --------------------------------------------------------------------------
# PythonTeX: latexmk -> pythontex -> latexmk
#
# The first latexmk is expected to fail: \includegraphics{plot.pdf} refers to a
# file the pylabblock has not produced yet. That is precisely why the editor
# runs the three-stage chain, so its exit status is ignored here.
# --------------------------------------------------------------------------
if is_true "$pythontex_enabled"; then
  echo ">> pythontex: latexmk -> pythontex -> latexmk"
  cat > pytex.tex <<'COCALC_FIXTURE_PYTEX'
\documentclass{article}
\usepackage[english]{babel}
\usepackage{graphicx}
\usepackage{dsfont}
\usepackage{pythontex}
\usepackage{amsmath}
\begin{document}

Number sets: $\mathds{N}$, $\mathds{Z}$, $\mathds{Q}$, $\mathds{R}$, $\mathds{C}$.

INLINE-RESULT: \py{123456788+1}

\begin{pycode}
import sympy as sp
x = sp.symbols('x')
F = sp.integrate(sp.exp(-x**2) * sp.cos(2*x), (x, -sp.oo, sp.oo))
Fval = "%.4f" % float(sp.N(F))
\end{pycode}

SYMPY-RESULT: \py{Fval}

\begin{pylabblock}
xs = linspace(-3, 3, 200)
figure(figsize=(4.5, 2.8))
plot(xs, exp(-xs**2) * cos(3*xs))
tight_layout()
savefig('plot.pdf')
\end{pylabblock}

\begin{center}
  \includegraphics{plot.pdf}
\end{center}

\end{document}
COCALC_FIXTURE_PYTEX

  $LATEXMK pytex.tex >pytex.pass1.log 2>&1 || true
  grep -q "pythontex.sty\|PythonTeX" pytex.pass1.log || {
    echo "first latexmk pass did not report pythontex; is the package installed?" >&2
    exit 1
  }

  pythontex_bin="$(command -v pythontex3 || command -v pythontex)"
  MPLBACKEND=Agg "$pythontex_bin" --jobs 2 pytex
  test -s plot.pdf || { echo "pylabblock did not produce plot.pdf" >&2; exit 1; }

  $LATEXMK pytex.tex >pytex.pass2.log 2>&1 || true
  test -s pytex.pdf || { echo "no pytex.pdf produced" >&2; exit 1; }

  expect_in_pdf pytex.pdf "INLINE-RESULT:123456789" "pythontex inline substitution"
  # The Gaussian cosine integral has the closed form sqrt(pi)/e, whose value is
  # 0.65204933..., so the "%.4f" formatting in the fixture yields 0.6520. The
  # symbolic result is exact, so this is stable across sympy versions.
  expect_in_pdf pytex.pdf "SYMPY-RESULT:0.6520" "pythontex sympy block"
  echo ">> pythontex OK"
fi

# --------------------------------------------------------------------------
# knitr: R knit() -> latexmk, for both .rnw and .rtex
# Command mirrors knitr() in latex-editor/knitr.ts.
# --------------------------------------------------------------------------
if is_true "$knitr_enabled"; then
  knit_one() {
    local src="$1" stem="$2"
    Rscript --no-save --no-restore --quiet -e \
      "require(knitr); opts_knit\$set(concordance = TRUE, progress = FALSE); knit('${src}')"
    test -s "${stem}.tex" || { echo "knitr produced no ${stem}.tex" >&2; return 1; }
    $LATEXMK "${stem}.tex" >"${stem}.build.log" 2>&1 || true
    test -s "${stem}.pdf" || { echo "no ${stem}.pdf produced" >&2; return 1; }
  }

  echo ">> knitr: .rnw"
  cat > knitrnw.rnw <<'COCALC_FIXTURE_RNW'
\documentclass{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\begin{document}

<<setup, include=FALSE>>=
library(knitr)
opts_chunk$set(cache=FALSE)
@

<<>>=
x <- c(2, 3, 7)
n <- 123456788L
summary(x)
@

<<histogram-plot, fig.width=5, fig.height=3, fig.align='center'>>=
hist(x)
@

RNW-RESULT: \Sexpr{n + 1L}

\end{document}
COCALC_FIXTURE_RNW

  knit_one knitrnw.rnw knitrnw
  expect_in_pdf knitrnw.pdf "RNW-RESULT:123456789" "knitr .rnw Sexpr"
  echo ">> knitr .rnw OK"

  echo ">> knitr: .rtex"
  cat > knitrtex.rtex <<'COCALC_FIXTURE_RTEX'
\documentclass{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\newcommand{\rinline}[1]{SOMETHING WRONG WITH knitr}
\begin{document}

%% begin.rcode setup, include=FALSE
% library(knitr)
% opts_chunk$set(cache=FALSE)
%% end.rcode

%% begin.rcode
% y = c(2, 3, 7)
% m = 123456788L
% t(y)
%% end.rcode

RTEX-RESULT: \rinline{m + 1L}

%% begin.rcode cairo-scatter, dev='cairo_pdf', fig.width=4, fig.height=4
% plot(cars)
%% end.rcode

\end{document}
COCALC_FIXTURE_RTEX

  knit_one knitrtex.rtex knitrtex
  expect_in_pdf knitrtex.pdf "RTEX-RESULT:123456789" "knitr .rtex inline expression"
  echo ">> knitr .rtex OK"
fi

# --------------------------------------------------------------------------
# R Markdown: Rscript rmarkdown::render, mirroring rmd-editor/rmd-converter.ts.
# The fixture declares output: pdf_document, and render is called with
# output_format = NULL so the frontmatter decides, exactly as in production.
# --------------------------------------------------------------------------
if is_true "$rmarkdown_enabled"; then
  echo ">> rmarkdown: Rscript rmarkdown::render"
  cat > rmddoc.rmd <<'COCALC_FIXTURE_RMD'
---
title: "Title"
output:
  pdf_document:
    toc: true
---

## Title

```{r}
summary(rnorm(100))
```

```{r}
cat("RMD-R-RESULT:", 123456788L + 1L, "\n")
```

```{python}
print("RMD-PY-RESULT:", 123456788 + 1)
```

```{python}
import numpy as np
import matplotlib.pyplot as plt
xx = np.linspace(-10, 10, 200)
plt.plot(xx, np.sin(xx) * xx)
```
COCALC_FIXTURE_RMD

  MPLBACKEND=Agg Rscript -e \
    "rmarkdown::render('rmddoc.rmd', output_format = NULL, run_pandoc = TRUE)"
  test -s rmddoc.pdf || { echo "rmarkdown produced no rmddoc.pdf" >&2; exit 1; }
  expect_in_pdf rmddoc.pdf "RMD-R-RESULT:123456789" "rmarkdown R chunk"
  expect_in_pdf rmddoc.pdf "RMD-PY-RESULT:123456789" "rmarkdown reticulate Python chunk"
  echo ">> rmarkdown OK"
fi

# --------------------------------------------------------------------------
# Quarto: quarto render, mirroring qmd-editor/qmd-converter.ts. No --to, so the
# fixture's `format: pdf` selects the output.
# --------------------------------------------------------------------------
if is_true "$quarto_enabled"; then
  echo ">> quarto: quarto render"
  command -v quarto >/dev/null || { echo "quarto not on PATH" >&2; exit 1; }
  cat > qmddoc.qmd <<'COCALC_FIXTURE_QMD'
---
title: "Title"
format: pdf
---

## Test

```{r}
cat("QMD-R-RESULT:", 123456788L + 1L, "\n")
```

```{python}
print("QMD-PY-RESULT:", 123456788 + 1)
```

```{python}
import numpy as np
import matplotlib.pyplot as plt
xx = np.linspace(-10, 10, 200)
plt.plot(xx, np.sin(xx) * xx)
```
COCALC_FIXTURE_QMD

  MPLBACKEND=Agg quarto render qmddoc.qmd --log-level info
  echo ">> quarto render returned"
  test -s qmddoc.pdf || { echo "quarto produced no qmddoc.pdf" >&2; exit 1; }
  echo ">> quarto pdf present ($(wc -c < qmddoc.pdf) bytes); extracting text"
  expect_in_pdf qmddoc.pdf "QMD-R-RESULT:123456789" "quarto R chunk"
  expect_in_pdf qmddoc.pdf "QMD-PY-RESULT:123456789" "quarto Python chunk"
  echo ">> quarto OK"
fi

echo ">> document toolchain verified"
