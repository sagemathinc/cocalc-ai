// Keep native icon names aligned with the web Icon aliases without importing DOM code.
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(root, "../frontend/components/icon.tsx"),
  "utf8",
);
const glyphs = require("../node_modules/@react-native-vector-icons/ant-design/glyphmaps/AntDesign.json");
const aliases = {};
for (const match of source.matchAll(
  /^\s*(?:"([^"]+)"|([\w-]+)):\s*(\w+)(?:Outlined|Filled|TwoTone),/gm,
)) {
  const name = match[3].replace(/([a-z\d])([A-Z])/g, "$1-$2").toLowerCase();
  if (glyphs[name]) aliases[match[1] || match[2]] = name;
}
fs.writeFileSync(
  path.join(root, "src/agents/icon-names.json"),
  JSON.stringify(aliases, null, 2) + "\n",
);
const css = fs.readFileSync(
  path.join(root, "../assets/cocalc-icons-font/style.css"),
  "utf8",
);
const glyphNames = Object.fromEntries(
  [
    ...css.matchAll(
      /\.cc-icon-([^:]+):before\s*{\s*content:\s*"\\([\da-f]+)"/g,
    ),
  ].map((m) => [m[1], String.fromCodePoint(parseInt(m[2], 16))]),
);
const custom = {};
for (const match of source.matchAll(
  /^\s*(?:"([^"]+)"|([\w-]+)):\s*{\s*IconFont:\s*"([^"]+)"/gm,
)) {
  if (glyphNames[match[3]]) custom[match[1] || match[2]] = glyphNames[match[3]];
}
fs.writeFileSync(
  path.join(root, "src/agents/custom-icon-names.json"),
  JSON.stringify(custom, null, 2) + "\n",
);
