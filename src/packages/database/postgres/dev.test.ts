import { resolveLocalPostgresArchiveTimeout } from "./dev";

describe("resolveLocalPostgresArchiveTimeout", () => {
  const original = process.env.COCALC_LOCAL_PG_ARCHIVE_TIMEOUT;

  afterEach(() => {
    if (original == null) {
      delete process.env.COCALC_LOCAL_PG_ARCHIVE_TIMEOUT;
    } else {
      process.env.COCALC_LOCAL_PG_ARCHIVE_TIMEOUT = original;
    }
  });

  it("defaults to one hour", () => {
    delete process.env.COCALC_LOCAL_PG_ARCHIVE_TIMEOUT;
    expect(resolveLocalPostgresArchiveTimeout()).toBe("1h");
  });

  it("uses the configured override", () => {
    process.env.COCALC_LOCAL_PG_ARCHIVE_TIMEOUT = "15min";
    expect(resolveLocalPostgresArchiveTimeout()).toBe("15min");
  });

  it("ignores blank overrides", () => {
    process.env.COCALC_LOCAL_PG_ARCHIVE_TIMEOUT = "   ";
    expect(resolveLocalPostgresArchiveTimeout()).toBe("1h");
  });
});
