const base = require("./jest.config.js");
const pkgs = ["util", "conat", "server", "lite"];
const map = {};
for (const p of pkgs) map[`^@cocalc/${p}/(.*)$`] = `<rootDir>/../${p}/$1`;
module.exports = { ...base, moduleNameMapper: { ...(base.moduleNameMapper ?? {}), ...map } };
