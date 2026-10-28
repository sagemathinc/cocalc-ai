/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The allowlist for a GPU launch: only these fields, within these bounds, ever
reach the provider. The server builds the provider request from the result,
never from the caller's object.
*/

import type { GpuLaunchSpec } from "./types";

// Images we have checked: they install PUBLIC_KEY as the only authorized SSH
// key and start sshd (SSH-KERNEL.md).
export const GPU_LAUNCH_IMAGES = [
  "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
] as const;

export const GPU_LAUNCH_LIMITS = {
  gpu_count: { min: 1, max: 8 },
  container_disk_gb: { min: 10, max: 200, default: 20 },
  volume_gb: { min: 0, max: 500, default: 0 },
  max_runtime_minutes: { min: 5, max: 24 * 60 },
  ports: 5,
  env_vars: 20,
  env_value_length: 1024,
  env_total_length: 8192,
} as const;

// Set by the server, or used by the provider's images for credentials.
const RESERVED_ENV =
  /^(PUBLIC_KEY|SSH_PUBLIC_KEY|JUPYTER_PASSWORD|RUNPOD_.*|CC_.*|COCALC_.*)$/;
// A credential doesn't belong in a pod's environment, which the provider
// shows to anyone with the key.
const SECRET_LIKE_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/;

function fail(message: string): never {
  throw Error(message);
}

function integer(
  value: unknown,
  name: string,
  { min, max }: { min: number; max: number },
  fallback?: number,
): number {
  if (value == null && fallback != null) return fallback;
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    fail(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function identifier(value: unknown, name: string, pattern: RegExp): string {
  const s = `${value ?? ""}`.trim();
  if (!pattern.test(s)) fail(`Enter a valid ${name}.`);
  return s;
}

// RunPod GPU type ids are names such as "NVIDIA GeForce RTX 4090".
const GPU_TYPE_ID = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{1,63}$/;
const DATA_CENTER_ID = /^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/;
const PORT = /^([1-9][0-9]{0,4})\/(tcp|http)$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ED25519_PUBLIC_KEY =
  /^ssh-ed25519 [A-Za-z0-9+/]{68}(?:=){0,2}(?: [^\s]{0,64})?$/;

export function normalizeGpuLaunchSpec(input: unknown): GpuLaunchSpec {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    fail("A launch needs a spec.");
  }
  const spec = input as Record<string, unknown>;
  const limits = GPU_LAUNCH_LIMITS;

  const cloud = spec.cloud == null ? "SECURE" : spec.cloud;
  if (cloud !== "SECURE" && cloud !== "COMMUNITY") {
    fail('cloud must be "SECURE" or "COMMUNITY".');
  }
  const image = `${spec.image ?? ""}`.trim();
  if (!(GPU_LAUNCH_IMAGES as readonly string[]).includes(image)) {
    fail(`image must be one of: ${GPU_LAUNCH_IMAGES.join(", ")}.`);
  }

  const portsInput = spec.ports ?? [];
  if (!Array.isArray(portsInput) || portsInput.length > limits.ports) {
    fail(`ports must be a list of at most ${limits.ports}.`);
  }
  const ports = [
    ...new Set(
      portsInput.map((p) => {
        const s = `${p ?? ""}`.trim();
        const m = PORT.exec(s);
        if (!m || Number(m[1]) > 65535) {
          fail('Each port must look like "22/tcp" or "8888/http".');
        }
        return s;
      }),
    ),
  ];

  const envInput = spec.env ?? {};
  if (typeof envInput !== "object" || Array.isArray(envInput)) {
    fail("env must map names to values.");
  }
  const envEntries = Object.entries(envInput as Record<string, unknown>);
  if (envEntries.length > limits.env_vars) {
    fail(`env may have at most ${limits.env_vars} variables.`);
  }
  let envLength = 0;
  const env: Record<string, string> = {};
  for (const [name, raw] of envEntries) {
    if (!ENV_NAME.test(name)) {
      fail(`env name ${JSON.stringify(name.slice(0, 64))} is not valid.`);
    }
    if (RESERVED_ENV.test(name)) {
      fail(`env ${name} is set by CoCalc.`);
    }
    if (SECRET_LIKE_ENV.test(name)) {
      fail(
        `env ${name} looks like a credential; the provider shows a pod's environment to anyone with the key, so pass credentials another way.`,
      );
    }
    if (typeof raw !== "string" || raw.length > limits.env_value_length) {
      fail(
        `env ${name} must be text of at most ${limits.env_value_length} characters.`,
      );
    }
    if (/[\x00]/.test(raw)) fail(`env ${name} has a NUL character.`);
    envLength += name.length + raw.length;
    env[name] = raw;
  }
  if (envLength > limits.env_total_length) {
    fail(`env may be at most ${limits.env_total_length} characters in all.`);
  }

  let ssh_public_key: string | undefined;
  if (spec.ssh_public_key != null) {
    ssh_public_key = `${spec.ssh_public_key}`.trim();
    if (!ED25519_PUBLIC_KEY.test(ssh_public_key)) {
      fail("ssh_public_key must be one ssh-ed25519 public key.");
    }
  }

  const result: GpuLaunchSpec = {
    gpu_type_id: identifier(spec.gpu_type_id, "GPU type", GPU_TYPE_ID),
    gpu_count: integer(spec.gpu_count, "gpu_count", limits.gpu_count, 1),
    cloud,
    image,
    container_disk_gb: integer(
      spec.container_disk_gb,
      "container_disk_gb",
      limits.container_disk_gb,
      limits.container_disk_gb.default,
    ),
    volume_gb: integer(
      spec.volume_gb,
      "volume_gb",
      limits.volume_gb,
      limits.volume_gb.default,
    ),
    ports,
    env,
    max_runtime_minutes: integer(
      spec.max_runtime_minutes,
      "max_runtime_minutes",
      limits.max_runtime_minutes,
    ),
  };
  if (spec.data_center_id != null && `${spec.data_center_id}`.trim()) {
    result.data_center_id = identifier(
      spec.data_center_id,
      "data center",
      DATA_CENTER_ID,
    );
  }
  if (ssh_public_key) result.ssh_public_key = ssh_public_key;
  return result;
}
