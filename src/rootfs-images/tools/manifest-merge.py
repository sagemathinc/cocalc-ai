#!/usr/bin/env python3
import argparse
import json
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
IMAGES_DIR = ROOT / "images"
ARTIFACTS_DIR = ROOT / "build-artifacts"


def run(cmd, check=True, capture=False):
    print("+", " ".join(cmd))
    if capture:
        return subprocess.check_output(cmd, text=True).strip()
    if check:
        subprocess.check_call(cmd)
    else:
        return subprocess.call(cmd)


def load_image(image_id: str):
    path = IMAGES_DIR / image_id / "image.yaml"
    if not path.exists():
        raise FileNotFoundError(f"missing image.yaml for {image_id}")
    data = yaml.safe_load(path.read_text())
    data["_path"] = str(path)
    return data


def build_tag(component_version: str):
    today = datetime.utcnow().strftime("%Y.%m.%d")
    return f"{component_version}-{today}"


def image_ref(registry: str, image_name: str, tag: str):
    return f"{registry.rstrip('/')}/{image_name}:{tag}"


def container_tool(name: str | None = None) -> str:
    if name:
        return name
    if shutil.which("podman"):
        return "podman"
    return "docker"


def get_digest(ref: str):
    try:
        if shutil.which("skopeo"):
            output = run(
                ["skopeo", "inspect", f"docker://{ref}", "--format", "{{.Digest}}"],
                capture=True,
            )
            return output.strip() or None
        if shutil.which("podman"):
            output = run(["podman", "manifest", "inspect", ref], capture=True)
            data = json.loads(output)
            return data.get("digest")
    except Exception as err:
        print("warning: unable to read digest", err)
    return None


def write_artifact(image_id: str, ref: str, tag: str, digest: str | None, archs):
    ARTIFACTS_DIR.mkdir(exist_ok=True)
    data = {
        "image_id": image_id,
        "ref": ref,
        "tag": tag,
        "digest": digest,
        "arch": archs,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    path = ARTIFACTS_DIR / f"{image_id}.json"
    path.write_text(json.dumps(data, indent=2))
    print(f"wrote build metadata: {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, help="image id")
    parser.add_argument("--registry", required=True, help="Artifact Registry base")
    parser.add_argument("--tag", default="")
    parser.add_argument("--arch", default="", help="comma-separated arch list")
    parser.add_argument("--tool", default="", help="podman or docker")
    args = parser.parse_args()

    image = load_image(args.image)
    component_version = image.get("component_version", "0")
    tag = args.tag or build_tag(component_version)

    archs = [a.strip() for a in args.arch.split(",") if a.strip()]
    if not archs:
        archs = image.get("arch") or ["amd64"]
    if isinstance(archs, str):
        archs = [archs]

    tool = container_tool(args.tool or None)
    image_name = image["image_name"]
    base_ref = image_ref(args.registry, image_name, tag)
    arch_refs = [image_ref(args.registry, image_name, f"{tag}-{a}") for a in archs]

    if tool == "podman":
        run([tool, "manifest", "rm", base_ref], check=False)
        run([tool, "manifest", "create", base_ref, *arch_refs])
        for arch, ref in zip(archs, arch_refs):
            run([tool, "manifest", "annotate", base_ref, ref, "--arch", arch])
        run([tool, "manifest", "push", "--all", base_ref, f"docker://{base_ref}"])
    else:
        run([tool, "manifest", "rm", base_ref], check=False)
        run([tool, "manifest", "create", base_ref, *arch_refs])
        for arch, ref in zip(archs, arch_refs):
            run([tool, "manifest", "annotate", base_ref, ref, "--arch", arch])
        run([tool, "manifest", "push", base_ref])

    digest = get_digest(base_ref)
    write_artifact(args.image, base_ref, tag, digest, archs)


if __name__ == "__main__":
    main()
