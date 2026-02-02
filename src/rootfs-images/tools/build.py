#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
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


def build_platforms(image):
    arch = image.get("arch") or ["amd64"]
    if isinstance(arch, str):
        arch = [arch]
    return arch


def docker_buildx(image, registry: str, tag: str):
    image_name = image["image_name"]
    platforms = build_platforms(image)
    platforms_csv = ",".join([f"linux/{a}" for a in platforms])
    dockerfile = str(Path(image["_path"]).parent / "Dockerfile")
    context_dir = str(Path(image["_path"]).parent)
    ref = image_ref(registry, image_name, tag)
    cmd = [
        "docker",
        "buildx",
        "build",
        "--platform",
        platforms_csv,
        "--push",
        "-t",
        ref,
        "-f",
        dockerfile,
        context_dir,
    ]
    run(cmd)
    return ref


def run_tests(image_ref_value: str, tests):
    for test in tests or []:
        name = test.get("name", "test")
        cmd = test.get("cmd")
        if not cmd:
            continue
        print(f"==> test: {name}")
        run(["docker", "run", "--rm", image_ref_value, "bash", "-lc", cmd])


def get_digest(ref: str):
    try:
        output = run(
            ["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .}}"],
            capture=True,
        )
        data = json.loads(output)
        return data.get("digest")
    except Exception as err:
        print("warning: unable to read digest", err)
        return None


def check_scan(ref: str, project: str):
    if not project:
        print("warning: no project set; skipping scan gating")
        return
    # Best-effort scan check using gcloud artifacts CLI.
    try:
        output = run(
            [
                "gcloud",
                "artifacts",
                "docker",
                "images",
                "list-vulnerabilities",
                ref,
                "--project",
                project,
                "--format=json",
            ],
            capture=True,
        )
        data = json.loads(output or "[]")
        severities = {"CRITICAL": 0, "HIGH": 0}
        for item in data:
            sev = item.get("severity")
            if sev in severities:
                severities[sev] += 1
        if severities["CRITICAL"] or severities["HIGH"]:
            raise RuntimeError(
                f"scan failed: {severities['CRITICAL']} critical, {severities['HIGH']} high"
            )
    except subprocess.CalledProcessError as err:
        print("warning: scan query failed", err)


def write_artifact(image_id: str, ref: str, tag: str, digest: str | None):
    ARTIFACTS_DIR.mkdir(exist_ok=True)
    data = {
        "image_id": image_id,
        "ref": ref,
        "tag": tag,
        "digest": digest,
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }
    path = ARTIFACTS_DIR / f"{image_id}.json"
    path.write_text(json.dumps(data, indent=2))
    print(f"wrote build metadata: {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, help="image id")
    parser.add_argument("--registry", required=True, help="Artifact Registry base")
    parser.add_argument("--project", default=os.environ.get("GCP_PROJECT", ""))
    parser.add_argument("--tag", default="")
    args = parser.parse_args()

    image = load_image(args.image)
    component_version = image.get("component_version", "0")
    tag = args.tag or build_tag(component_version)
    ref = docker_buildx(image, args.registry, tag)

    run_tests(ref, image.get("tests"))

    digest = get_digest(ref)
    check_scan(ref, args.project)

    write_artifact(args.image, ref, tag, digest)


if __name__ == "__main__":
    main()
