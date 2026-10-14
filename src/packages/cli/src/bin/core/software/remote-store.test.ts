import assert from "node:assert/strict";
import test from "node:test";

import {
  loadDefaultSoftwareR2Client,
  publicSoftwareBaseUrl,
  resolveSoftwareRemoteConfig,
} from "./remote-store";

test("software R2 loader exposes backend helper functions", () => {
  const client = loadDefaultSoftwareR2Client();
  assert.equal(typeof client.putR2ObjectFromFile, "function");
  assert.equal(typeof client.putR2ObjectFromBuffer, "function");
  assert.equal(typeof client.getR2ObjectBuffer, "function");
  assert.equal(typeof client.copyR2Object, "function");
});

const env = {
  COCALC_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  COCALC_R2_ACCESS_KEY_ID: "access",
  COCALC_R2_SECRET_ACCESS_KEY: "secret",
  COCALC_R2_BUCKET: "bucket",
};
const noEnvFile = "/nonexistent/cocalc-software-env.sh";

test("the public base URL is normalized without trailing slashes", async () => {
  const config = await resolveSoftwareRemoteConfig({
    env: { ...env, COCALC_R2_PUBLIC_BASE_URL: "https://software.cocalc.ai//" },
    envFile: noEnvFile,
  });
  assert.equal(config.publicBaseUrl, "https://software.cocalc.ai");
  assert.equal(
    config.auth.endpoint,
    "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  );
});

test("the R2 S3 API endpoint is refused as the public base URL", async () => {
  await assert.rejects(
    resolveSoftwareRemoteConfig({
      env: {
        ...env,
        COCALC_R2_PUBLIC_BASE_URL:
          "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      },
      envFile: noEnvFile,
    }),
    (err: Error) => {
      assert.match(err.message, /R2 S3 API endpoint/);
      assert.match(err.message, /https:\/\/software\.cocalc\.ai/);
      // The account id is part of the endpoint host; never echo it.
      assert.doesNotMatch(err.message, /0123456789abcdef/);
      return true;
    },
  );
});

test("a custom S3 endpoint is refused as the public base URL", () => {
  assert.throws(
    () =>
      publicSoftwareBaseUrl(
        "https://s3.example.test/software",
        "https://s3.example.test",
      ),
    /R2 S3 API endpoint/,
  );
  assert.equal(
    publicSoftwareBaseUrl(
      "https://software.example.test/",
      "https://s3.example.test",
    ),
    "https://software.example.test",
  );
});

test("public base URLs must be absolute http(s) URLs", () => {
  for (const value of ["software.cocalc.ai", "ftp://software.cocalc.ai"]) {
    assert.throws(
      () => publicSoftwareBaseUrl(value, "https://x.r2.cloudflarestorage.com"),
      /COCALC_R2_PUBLIC_BASE_URL must be/,
    );
  }
});
