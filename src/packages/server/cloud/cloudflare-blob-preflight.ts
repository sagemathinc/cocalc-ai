// The managed wizard cannot change environment configuration on any bay.
// Reject overrides rather than probe one store while runtime uses another.
export function assertManagedBlobEnvironment(): void {
  if (
    Object.entries(process.env).some(
      ([name, value]) =>
        (name === "COCALC_BLOB_STORAGE_BACKEND" ||
          name.startsWith("COCALC_BLOB_R2_")) &&
        value?.trim(),
    )
  ) {
    throw Error(
      "Managed Cloudflare setup does not support COCALC_BLOB_* environment overrides. Review and remove these overrides on every bay before using the wizard; this does not migrate existing blob data.",
    );
  }
}

// Return only a capability result, never environment values or credentials.
export function checkCloudflareBlobEnvironment(): { ok: boolean } {
  try {
    assertManagedBlobEnvironment();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
