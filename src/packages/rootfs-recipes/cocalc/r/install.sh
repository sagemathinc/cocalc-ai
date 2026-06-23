set -euo pipefail

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
owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"
jupyter_prefix="${JUPYTER_PREFIX:-/opt/cocalc-r-jupyter}"

$SUDO apt-get update
run_noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl gfortran libcurl4-openssl-dev libssl-dev libxml2-dev \
  python3 python3-venv r-base r-base-dev

$SUDO mkdir -p "$jupyter_prefix"
$SUDO chown -R "$(id -u):$(id -g)" "$jupyter_prefix"
python3 -m venv --clear "$jupyter_prefix"
"$jupyter_prefix/bin/pip" install --no-cache-dir --upgrade pip setuptools wheel
"$jupyter_prefix/bin/pip" install --no-cache-dir jupyter_client
$SUDO ln -sf "$jupyter_prefix/bin/jupyter" /usr/local/bin/jupyter

$SUDO Rscript --vanilla - <<RS
options(repos = c(CRAN = "$cran"))
if (!requireNamespace("IRkernel", quietly = TRUE)) {
  install.packages("IRkernel", Ncpus = max(1, parallel::detectCores(logical = FALSE)))
}
IRkernel::installspec(prefix = "/usr/local", user = FALSE)
RS

$SUDO chown -R "$owner_uid:$owner_gid" /usr/local/share/jupyter/kernels/ir || true
$SUDO chown -R "$owner_uid:$owner_gid" "$jupyter_prefix"
$SUDO chmod -R u+rwX,go+rX "$jupyter_prefix"
$SUDO rm -rf /var/lib/apt/lists/*
