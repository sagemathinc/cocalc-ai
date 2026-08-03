set -Eeuo pipefail

# Merge stderr into stdout. The build log is a single stream, and stdout is
# block-buffered when piped while stderr is not, so keeping them separate
# reorders failure messages away from the step they belong to.
exec 2>&1

# Report which command failed; a bare command aborting under `set -e`
# otherwise produces no output at all.
trap 'echo "install: FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

# R and Python layer for LaTeX-adjacent document formats:
#
#   - knitr, for .rnw and .rtex, which CoCalc renders to .tex before latexmk,
#   - rmarkdown, for .rmd, rendered with Rscript honouring the frontmatter,
#   - reticulate, so a single .rmd/.qmd can mix R and Python chunks,
#   - scientific Python, which PythonTeX blocks in .tex documents import.
#
# Quarto is intentionally not installed here; compose cocalc/quarto as its own
# step so its arch handling and release resolution stay in one place.

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

run_noninteractive() {
  if [ -n "$SUDO" ]; then
    $SUDO env DEBIAN_FRONTEND=noninteractive "$@"
  else
    DEBIAN_FRONTEND=noninteractive "$@"
  fi
}

cran="${CRAN:-https://cloud.r-project.org}"
reticulate_python="${RETICULATE_PYTHON:-/usr/bin/python3}"
install_reticulate="${INSTALL_RETICULATE:-true}"
clean="${CLEAN:-true}"

is_true() {
  case "$1" in
    true|True|TRUE|1|yes) return 0 ;;
    *) return 1 ;;
  esac
}

# Package lists are empty in the base images, so an update is required before
# the first install rather than optional.
$SUDO apt-get update

# r-base-dev is needed to compile CRAN packages such as reticulate; without it
# install.packages() fails at the configure stage.
run_noninteractive apt-get install -y --no-install-recommends \
  pandoc \
  r-base \
  r-base-dev \
  r-cran-broom \
  r-cran-data.table \
  r-cran-dplyr \
  r-cran-ggplot2 \
  r-cran-knitr \
  r-cran-lubridate \
  r-cran-readr \
  r-cran-rmarkdown \
  r-cran-stringr \
  r-cran-tidyr \
  r-cran-xtable

# Scientific Python for PythonTeX blocks, plus Pygments for pythontex/minted
# syntax highlighting.
run_noninteractive apt-get install -y --no-install-recommends \
  python3-matplotlib \
  python3-numpy \
  python3-pygments \
  python3-scipy \
  python3-sympy

if is_true "$install_reticulate"; then
  # The system R library is root-owned, so this needs privilege; without it R
  # falls back to a per-user library that the published image will not have.
  $SUDO Rscript -e "install.packages('reticulate', repos = '${cran}', Ncpus = parallel::detectCores())"
  Rscript -e "stopifnot('reticulate' %in% rownames(installed.packages()))"

  # Pin the interpreter so reticulate never prompts to bootstrap its own
  # environment. Replace rather than preserve an existing entry: keeping the old
  # value would make a changed input silently ineffective, and verification
  # asserts the configured interpreter is the active one.
  renviron="/etc/R/Renviron.site"
  $SUDO touch "$renviron"
  if grep -q "^RETICULATE_PYTHON=" "$renviron" 2>/dev/null; then
    $SUDO sed -i "s|^RETICULATE_PYTHON=.*|RETICULATE_PYTHON=${reticulate_python}|" "$renviron"
  else
    echo "RETICULATE_PYTHON=${reticulate_python}" | $SUDO tee -a "$renviron" >/dev/null
  fi
fi

if is_true "$clean"; then
  # Deliberately narrower than a general-purpose cleanup: temp directories are
  # left alone because the recipe runner and later verify steps use them.
  run_noninteractive apt-get autoremove -y --purge
  $SUDO apt-get clean
  $SUDO rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
fi

echo ">> R and Python document layer installed"
