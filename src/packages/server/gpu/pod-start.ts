/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
GPU bring-your-own-key, step 4: the start command of a pod that takes SSH
(see ~/ops2/runpod/HOSTKEY-REGISTRATION.md, approved 10-28).

The image's own /start.sh installs PUBLIC_KEY and runs sshd, so it stays the
container's main process. Before it runs, synchronously:

1. generate the host keys (ssh-keygen -A): this script is their source, so
   /start.sh finds them present;
2. refuse any active `Match` in sshd_config or anything it includes (a Match
   block can override global settings for the connections it matches);
3. atomically prepend the hardening directives to sshd_config (sshd uses the
   first value it reads, so they win over the image's own lines);
4. check the real config with `sshd -t`.

Any failure exits the container before sshd ever starts. Then a background
registrar is started, the token is removed from the environment the image's
start (and sshd) inherit, and /start.sh is exec'd. The registrar waits for
sshd and the host key, checks the effective config for a connection, and
only then reports the host key once, over HTTPS, with the token given to
curl on stdin (never in argv, a file or a log).

The script holds no secret: the token comes from the pod's env.
*/

export const POD_REGISTRATION_URL_ENV = "CC_HOSTKEY_URL";
export const POD_REGISTRATION_TOKEN_ENV = "CC_HOSTKEY_TOKEN";

export interface PodStartOptions {
  // for tests; the defaults are the measured image's paths
  sshdConfig?: string;
  sshDir?: string;
  sshd?: string;
  sshKeygen?: string;
  curl?: string;
  start?: string;
  privsepDir?: string;
  // registrar limits, seconds
  retryDelaySeconds?: number;
  waitSeconds?: number;
  postSeconds?: number;
}

function q(path: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(path)) throw new Error("unsafe path");
  return `'${path}'`;
}

export function podStartScript(opts: PodStartOptions = {}): string {
  const sshDir = q(opts.sshDir ?? "/etc/ssh");
  const config = q(opts.sshdConfig ?? "/etc/ssh/sshd_config");
  const sshd = q(opts.sshd ?? "/usr/sbin/sshd");
  const keygen = q(opts.sshKeygen ?? "ssh-keygen");
  const curl = q(opts.curl ?? "curl");
  const start = q(opts.start ?? "/start.sh");
  const privsep = q(opts.privsepDir ?? "/run/sshd");
  const delay0 = Math.max(1, Math.floor(opts.retryDelaySeconds ?? 2));
  const wait = Math.max(1, Math.floor(opts.waitSeconds ?? 600));
  const post = Math.max(1, Math.floor(opts.postSeconds ?? 900));
  return `set +x
set -u
cc_fail() { echo "cocalc: $1; not starting sshd" >&2; exit 1; }

# 1. Host keys, made here so /start.sh keeps them.
${keygen} -A >/dev/null 2>&1 || cc_fail "ssh-keygen -A failed"
[ -s ${sshDir}/ssh_host_ed25519_key.pub ] || cc_fail "no ed25519 host key"

# 2. No active Match anywhere in the config (at most 4 levels, 64 files).
cc_files=0
cc_scan() {
  local file="$1" depth="$2" line word rest arg path
  [ "$depth" -le 4 ] || return 1
  cc_files=$((cc_files + 1)); [ "$cc_files" -le 64 ] || return 1
  [ -r "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="\${line#"\${line%%[![:space:]]*}"}"
    case "$line" in ""|"#"*) continue ;; esac
    word="\${line%%[[:space:]=]*}"; rest="\${line#"$word"}"
    case "\${word,,}" in
      match) return 1 ;;
      include)
        case "$rest" in *\\"*|*\\'*) return 1 ;; esac
        # split without globbing: patterns are relative to the ssh dir
        set -f; set -- $rest; set +f
        for arg in "$@"; do
          [ "$arg" = "=" ] && continue
          case "$arg" in /*) path="$arg" ;; *) path=${sshDir}/"$arg" ;; esac
          case "$path" in
            *[*?[]*)
              for f in $path; do [ -e "$f" ] || continue; cc_scan "$f" $((depth + 1)) || return 1; done ;;
            *) cc_scan "$path" $((depth + 1)) || return 1 ;;
          esac
        done ;;
    esac
  done < "$file"
  return 0
}
cc_scan ${config} 1 || cc_fail "sshd_config has a Match block or an include it can't read"

# 3. Hardening first in sshd_config, atomically.
cc_tmp=${config}.cocalc.$$
{ printf '%s\\n' '# CoCalc: key-only login (these first values win)' \\
    'PasswordAuthentication no' 'KbdInteractiveAuthentication no' \\
    'PermitRootLogin prohibit-password'
  cat ${config}; } > "$cc_tmp" || cc_fail "can't write sshd_config"
chmod 644 "$cc_tmp" && mv -f "$cc_tmp" ${config} || cc_fail "can't replace sshd_config"

# 4. The real config, with the host keys present (and sshd's privilege
# separation directory, which /start.sh would otherwise make later).
mkdir -p ${privsep} && chmod 755 ${privsep} || cc_fail "can't make ${privsep}"
${sshd} -t >/dev/null 2>&1 || cc_fail "sshd -t rejected the config"

# The registrar alone keeps the token.
(
  set +x
  cc_effective() {
    local out
    out="$(${sshd} -T -C user=root,host=pod,addr=203.0.113.1 2>/dev/null)" || return 1
    printf '%s\\n' "$out" | grep -qx 'passwordauthentication no' &&
    printf '%s\\n' "$out" | grep -qx 'kbdinteractiveauthentication no' &&
    printf '%s\\n' "$out" | grep -Eqx 'permitrootlogin (without-password|prohibit-password)'
  }
  cc_up() { pgrep -x sshd >/dev/null 2>&1 || [ -s /run/sshd.pid ]; }
  t=0
  until cc_up && [ -s ${sshDir}/ssh_host_ed25519_key.pub ]; do
    t=$((t + 2)); [ "$t" -le ${wait} ] || exit 1; sleep 2
  done
  cc_effective || exit 1
  case "\${RUNPOD_POD_ID:-}" in ""|*[!A-Za-z0-9_-]*) exit 1 ;; esac
  read -r cc_type cc_blob _ < ${sshDir}/ssh_host_ed25519_key.pub || exit 1
  [ "$cc_type" = ssh-ed25519 ] || exit 1
  case "$cc_blob" in ""|*[!A-Za-z0-9+/=]*) exit 1 ;; esac
  cc_body="{\\"pod_id\\":\\"$RUNPOD_POD_ID\\",\\"host_public_key\\":\\"ssh-ed25519 $cc_blob\\"}"
  t=0; delay=${delay0}
  while [ "$t" -le ${post} ]; do
    code="$(printf 'Authorization: Bearer %s\\n' "\${${POD_REGISTRATION_TOKEN_ENV}:-}" |
      ${curl} -sS --proto =https --max-time 20 -o /dev/null -w '%{http_code}' \\
        -H @- -H 'Content-Type: application/json' --data-binary "$cc_body" \\
        "\${${POD_REGISTRATION_URL_ENV}:-}" 2>/dev/null)" || code=000
    case "$code" in
      200) break ;;
      409|429|000|5??) sleep "$delay"; t=$((t + delay)); [ "$delay" -lt 30 ] && delay=$((delay * 2)) ;;
      *) break ;;
    esac
  done
  unset ${POD_REGISTRATION_TOKEN_ENV} ${POD_REGISTRATION_URL_ENV}
) </dev/null >/dev/null 2>&1 &

unset ${POD_REGISTRATION_TOKEN_ENV} ${POD_REGISTRATION_URL_ENV}
exec ${start}
`;
}

// The RunPod create body's command for such a pod.
export function podStartCommand(opts: PodStartOptions = {}): {
  entrypoint: string[];
  cmd: string[];
} {
  return { entrypoint: ["/bin/bash", "-c"], cmd: [podStartScript(opts)] };
}
