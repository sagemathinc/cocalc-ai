// Tests get an in-memory lite sqlite database, unless a test names a file.
// Otherwise every test that reaches initDatabase() without mocking it opens
// the package's real data/lite/hub/sqlite.db, shared by every jest process
// running here, and fails with "database is locked" whenever two overlap.
// (jest gives each test file its own module registry, so each file starts
// with an empty database.)
if (!process.env.COCALC_LITE_SQLITE_FILENAME) {
  process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
}
