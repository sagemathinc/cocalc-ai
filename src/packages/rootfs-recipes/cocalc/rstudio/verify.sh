set -euo pipefail

command -v rserver
command -v cocalc-rstudio-server
Rscript --vanilla -e 'stopifnot(requireNamespace("shiny", quietly=TRUE)); stopifnot(requireNamespace("rmarkdown", quietly=TRUE))'
test -f /opt/cocalc-r/examples/shiny-hello/app.R
