import {
  decryptSecretSettingValue,
  encryptSecretSettingValue,
  isEncryptedSecretSettingValue,
} from "./secret-settings-crypto";

const KEY = Buffer.alloc(32, 5);

describe("secret-settings-crypto", () => {
  it("round-trips encrypted values with matching name", () => {
    const name = "stripe_secret_key";
    const value = "sk_test_123";
    const encrypted = encryptSecretSettingValue(name, value, KEY);
    expect(isEncryptedSecretSettingValue(encrypted)).toBe(true);
    const decrypted = decryptSecretSettingValue(name, encrypted, KEY);
    expect(decrypted).toBe(value);
  });

  it("rejects decrypting with a different setting name", () => {
    const encrypted = encryptSecretSettingValue("sendgrid_key", "key", KEY);
    expect(() =>
      decryptSecretSettingValue("stripe_secret_key", encrypted, KEY),
    ).toThrow();
  });

  it("passes through plaintext values", () => {
    const value = "plain-text";
    const decrypted = decryptSecretSettingValue("sendgrid_key", value, KEY);
    expect(decrypted).toBe(value);
  });

  it("does not double-encrypt encrypted values", () => {
    const name = "r2_secret_access_key";
    const value = "secret";
    const encrypted = encryptSecretSettingValue(name, value, KEY);
    const double = encryptSecretSettingValue(name, encrypted, KEY);
    expect(double).toBe(encrypted);
  });
});
