// Cloud-init may regenerate /etc/ssh host keys when a preserved boot disk is
// attached to a new provider instance. Keep the managed VM's identity elsewhere.
export function managedVmSshHostIdentityScript(): string {
  return `install -d -m 0700 /var/lib/cocalc-managed-vm/ssh-host-keys
install -d -m 0755 /etc/ssh/sshd_config.d
host_key_config=$(mktemp)
for type in ed25519 ecdsa rsa; do
  key=/var/lib/cocalc-managed-vm/ssh-host-keys/ssh_host_"$type"_key
  source=/etc/ssh/ssh_host_"$type"_key
  if [ ! -s "$key" ] && [ -s "$source" ]; then
    install -m 0600 "$source" "$key"
  fi
  if [ -s "$key" ]; then
    chmod 0600 "$key"
    printf 'HostKey %s\\n' "$key" >>"$host_key_config"
  fi
done
if [ ! -s "$host_key_config" ]; then
  rm -f "$host_key_config"
  echo "No SSH host keys are available for the managed VM" >&2
  exit 1
fi
install -m 0600 "$host_key_config" /etc/ssh/sshd_config.d/00-cocalc-host-keys.conf
rm -f "$host_key_config"
`;
}
