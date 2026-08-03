set -Eeuo pipefail

# Merge stderr into stdout. The build log is a single stream, and stdout is
# block-buffered when piped while stderr is not, so keeping them separate
# reorders failure messages away from the step they belong to.
exec 2>&1

# Report which command failed; a bare command aborting under `set -e`
# otherwise produces no output at all.
trap 'echo "verify: FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

install_reticulate="${INSTALL_RETICULATE:-true}"
reticulate_python="${RETICULATE_PYTHON:-/usr/bin/python3}"

echo ">> verifying R and Python document layer"

for exe in R Rscript pandoc python3; do
  command -v "$exe" >/dev/null || { echo "missing on PATH: $exe" >&2; exit 1; }
done

Rscript -e 'stopifnot(all(c("knitr","rmarkdown","ggplot2","dplyr","data.table") %in% rownames(installed.packages())))'
python3 -c 'import numpy, scipy, sympy, matplotlib, pygments'

if [ "$install_reticulate" = "true" ] || [ "$install_reticulate" = "1" ]; then
  Rscript -e 'stopifnot("reticulate" %in% rownames(installed.packages()))'
  grep -q "^RETICULATE_PYTHON=${reticulate_python}\$" /etc/R/Renviron.site
  # The pin must actually take effect, not merely be written to the file.
  Rscript -e "stopifnot(Sys.getenv('RETICULATE_PYTHON') == '${reticulate_python}')"
fi

echo ">> R and Python document layer verified"
