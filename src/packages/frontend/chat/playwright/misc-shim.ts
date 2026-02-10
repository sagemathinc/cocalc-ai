export function get_local_storage(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function set_local_storage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore in harness
  }
}

export function delete_local_storage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore in harness
  }
}

export function open_new_tab(): void {
  // no-op in harness
}
