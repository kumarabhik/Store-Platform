// better-sqlite3 is a native addon; on a host whose Node ABI it wasn't built for it can't load
// (SYSTEM.md L13). Such suites skip there and run in the Node 20 container (scripts/test-backend.sh).
export const sqliteAvailable = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

if (!sqliteAvailable) {
  console.warn("[test] better-sqlite3 not loadable on this Node; SQLite suites skipped. Run: bash scripts/test-backend.sh");
}
