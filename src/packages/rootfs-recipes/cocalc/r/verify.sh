set -euo pipefail

command -v R
command -v Rscript
Rscript --vanilla -e 'stopifnot(requireNamespace("IRkernel", quietly=TRUE)); cat(R.version.string, "\n")'
jupyter kernelspec list 2>/dev/null | grep -q ' ir\b\|/ir$'
