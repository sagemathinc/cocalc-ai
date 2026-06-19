set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

source_path="${SOURCE:?source is required}"
target_path="${TARGET:?target is required}"

$SUDO mkdir -p "$target_path"
$SUDO cp -a "$source_path"/. "$target_path"/
$SUDO chmod -R go+rX "$target_path"
