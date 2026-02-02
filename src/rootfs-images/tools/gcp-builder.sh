#!/usr/bin/env bash
set -euo pipefail

IMAGE_ID=""
PROJECT=""
ZONE=""
REGISTRY=""
MACHINE_TYPE="n2-standard-8"
NAME_PREFIX="rootfs-builder"
REPO_URL="https://github.com/sagemathinc/cocalc-ai.git"
REPO_TOKEN=""
REPO_TAR_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE_ID="$2"; shift 2;;
    --project) PROJECT="$2"; shift 2;;
    --zone) ZONE="$2"; shift 2;;
    --registry) REGISTRY="$2"; shift 2;;
    --repo-url) REPO_URL="$2"; shift 2;;
    --repo-token) REPO_TOKEN="$2"; shift 2;;
    --repo-tar) REPO_TAR_URL="$2"; shift 2;;
    --machine-type) MACHINE_TYPE="$2"; shift 2;;
    --name-prefix) NAME_PREFIX="$2"; shift 2;;
    *) echo "unknown arg $1"; exit 1;;
  esac
done

if [[ -z "$IMAGE_ID" || -z "$PROJECT" || -z "$ZONE" || -z "$REGISTRY" ]]; then
  echo "usage: gcp-builder.sh --image <id> --project <gcp-project> --zone <zone> --registry <artifact-registry> [--repo-url <url>] [--repo-token <token>] [--repo-tar <url>]" >&2
  exit 1
fi

NAME="${NAME_PREFIX}-${IMAGE_ID}-$(date +%s)"
STARTUP_SCRIPT=$(mktemp)
cat >"$STARTUP_SCRIPT" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

IMAGE_ID="${IMAGE_ID}"
REGISTRY="${REGISTRY}"
PROJECT="${PROJECT}"
REPO_URL="${REPO_URL}"
REPO_TOKEN="${REPO_TOKEN}"
REPO_TAR_URL="${REPO_TAR_URL}"

apt-get update -y
apt-get install -y git docker.io python3 python3-yaml
systemctl start docker

WORKDIR=/root/rootfs-images
mkdir -p "$WORKDIR"

if [[ -n "$REPO_TAR_URL" ]]; then
  echo "Downloading repo tarball from $REPO_TAR_URL"
  curl -fsSL "$REPO_TAR_URL" | tar -xz -C "$WORKDIR" --strip-components=1
else
  if [[ -n "$REPO_TOKEN" ]]; then
    AUTH_URL="https://${REPO_TOKEN}@${REPO_URL#https://}"
  else
    AUTH_URL="$REPO_URL"
  fi
  if [[ ! -d "$WORKDIR/.git" ]]; then
    git clone "$AUTH_URL" "$WORKDIR"
  fi
fi

cd "$WORKDIR/src/rootfs-images"
python3 tools/build.py --image "$IMAGE_ID" --registry "$REGISTRY" --project "$PROJECT"
SCRIPT

# Replace variables in startup script
sed -i "s|\${IMAGE_ID}|$IMAGE_ID|g" "$STARTUP_SCRIPT"
sed -i "s|\${REGISTRY}|$REGISTRY|g" "$STARTUP_SCRIPT"
sed -i "s|\${PROJECT}|$PROJECT|g" "$STARTUP_SCRIPT"
sed -i "s|\${REPO_URL}|$REPO_URL|g" "$STARTUP_SCRIPT"
sed -i "s|\${REPO_TOKEN}|$REPO_TOKEN|g" "$STARTUP_SCRIPT"
sed -i "s|\${REPO_TAR_URL}|$REPO_TAR_URL|g" "$STARTUP_SCRIPT"

set -x

gcloud compute instances create "$NAME" \
  --project "$PROJECT" \
  --zone "$ZONE" \
  --machine-type "$MACHINE_TYPE" \
  --provisioning-model=SPOT \
  --instance-termination-action=DELETE \
  --maintenance-policy=TERMINATE \
  --metadata-from-file startup-script="$STARTUP_SCRIPT" \
  --boot-disk-size=200GB \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud

echo "Instance $NAME created in $ZONE. Delete it when the build finishes."
