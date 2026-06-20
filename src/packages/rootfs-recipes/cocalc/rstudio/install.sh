set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

download_url="${DOWNLOAD_URL:-https://rstudio.org/download/latest/stable/server/jammy/rstudio-server-latest-amd64.deb}"
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

$SUDO apt-get update
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl gdebi-core libclang-dev libssl-dev psmisc r-base \
  r-cran-rmarkdown r-cran-shiny

tmp="$(mktemp --suffix=.deb)"
curl -fL "$download_url" -o "$tmp"
$SUDO DEBIAN_FRONTEND=noninteractive gdebi -n "$tmp"
rm -f "$tmp"

$SUDO ln -sf /usr/lib/rstudio-server/bin/rserver /usr/local/bin/rserver
$SUDO Rscript --vanilla -e 'stopifnot(requireNamespace("shiny", quietly=TRUE)); stopifnot(requireNamespace("rmarkdown", quietly=TRUE))'

$SUDO mkdir -p /opt/cocalc-r/examples/shiny-hello
$SUDO tee /opt/cocalc-r/examples/shiny-hello/app.R >/dev/null <<'RS'
library(shiny)

ui <- fluidPage(
  titlePanel("Hello from CoCalc RootFS"),
  sidebarLayout(
    sidebarPanel(sliderInput("n", "Rows", min = 1, max = 10, value = 5)),
    mainPanel(tableOutput("table"))
  )
)

server <- function(input, output, session) {
  output$table <- renderTable(head(mtcars, input$n), rownames = TRUE)
}

shinyApp(ui, server)
RS

$SUDO tee /usr/local/bin/cocalc-rstudio-server >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
host="${HOST:-127.0.0.1}"
port="${PORT:-6010}"
run_dir="${TMPDIR:-/tmp}/cocalc-rstudio-${USER:-user}"
mkdir -p "$run_dir"
cookie_key="$run_dir/secure-cookie-key"
if [ ! -f "$cookie_key" ]; then
  umask 077
  head -c 32 /dev/urandom >"$cookie_key"
fi
exec rserver \
  --server-daemonize=0 \
  --www-address="$host" \
  --www-port="$port" \
  --auth-none=1 \
  --server-user="$(id -un)" \
  --secure-cookie-key-file="$cookie_key" \
  --database-config-file="$run_dir/database.conf"
EOF
$SUDO chmod 755 /usr/local/bin/cocalc-rstudio-server

$SUDO chown -R "$owner_uid:$owner_gid" /opt/cocalc-r
$SUDO chmod -R u+rwX,go+rX /opt/cocalc-r
$SUDO rm -rf /var/lib/apt/lists/*
