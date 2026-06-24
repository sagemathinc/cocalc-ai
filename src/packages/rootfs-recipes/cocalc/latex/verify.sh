set -euo pipefail

command -v pdflatex
command -v xelatex
command -v lualatex
command -v latexmk
command -v bibtex
command -v biber
command -v makeindex
command -v pygmentize
command -v dvisvgm
command -v qpdf
command -v pandoc

kpsewhich comment.sty
kpsewhich babel-french.tex
kpsewhich IEEEtran.cls
kpsewhich standalone.cls
kpsewhich minted.sty
kpsewhich tikz.sty
kpsewhich pgfplots.sty
kpsewhich fontspec.sty

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

cat >main.tex <<'TEX'
\documentclass[12pt]{report}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[french]{babel}
\usepackage{comment}
\usepackage{graphicx}
\usepackage{geometry}
\usepackage{hyperref}
\usepackage{setspace}
\usepackage{float}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{tikz}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\begin{document}
\begin{comment}
This block verifies comment.sty is installed.
\end{comment}
\chapter{Résumé}
Bonjour. Voici une formule:
\[
  \sum_{n=1}^{10} n = 55.
\]
\begin{figure}[H]
\centering
\begin{tikzpicture}
  \begin{axis}[width=6cm,height=4cm]
    \addplot coordinates {(0,0) (1,1) (2,4)};
  \end{axis}
\end{tikzpicture}
\caption{PGFPlots smoke test}
\end{figure}
\end{document}
TEX

latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
test -s main.pdf
qpdf --check main.pdf >/dev/null

cat >fontspec-smoke.tex <<'TEX'
\documentclass{article}
\usepackage{fontspec}
\setmainfont{Latin Modern Roman}
\begin{document}
XeLaTeX and LuaLaTeX smoke test.
\end{document}
TEX

xelatex -interaction=nonstopmode -halt-on-error fontspec-smoke.tex >/dev/null
lualatex -interaction=nonstopmode -halt-on-error fontspec-smoke.tex >/dev/null
test -s fontspec-smoke.pdf

cat >refs.bib <<'BIB'
@article{sample,
  author = {Doe, Jane},
  title = {A sample article},
  journal = {Journal of Examples},
  year = {2026}
}
BIB

cat >biber-smoke.tex <<'TEX'
\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{refs.bib}
\begin{document}
\cite{sample}
\printbibliography
\end{document}
TEX

pdflatex -interaction=nonstopmode -halt-on-error biber-smoke.tex >/dev/null
biber biber-smoke >/dev/null
pdflatex -interaction=nonstopmode -halt-on-error biber-smoke.tex >/dev/null
