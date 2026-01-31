// next.js defines / to be an invalid basepath, whereas in cocalc it is valid:
const BASE_PATH = process.env.BASE_PATH ?? "/";

// next.js definition:
const basePath = BASE_PATH == "/" ? "" : BASE_PATH;

const { join, resolve, sep } = require("path");

// Important!  We include resolve('.') and basePath to avoid
// any possibility of multiple cocalc installs or different base
// paths conflicting with each other and causing corruption.
const cacheDirectory = join(
  `/tmp/nextjs-${require("os").userInfo().username}`,
  basePath,
  resolve("."),
);

const config = {
  basePath,
  env: { BASE_PATH },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  // Keep pglite in node_modules so its .data/.wasm assets resolve at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  webpack: (config, { buildId, dev, isServer, defaultLoaders, webpack }) => {
    // Webpack breaks without this pg-native alias, even though it's dead code,
    // due to how the pg module does package detection internally.
    config.resolve.alias["pg-native"] = ".";
    // Some backend code uses @lydell/node-pty but it won't be used in next:
    config.resolve.alias["@lydell/node-pty"] = ".";
    // These aliases are so we don't end up with two distinct copies
    // of React in our application, since this doesn't work at all!
    config.resolve.alias["react"] = resolve(__dirname, "node_modules", "react");
    config.resolve.alias["react-dom"] = resolve(
      __dirname,
      "node_modules",
      "react-dom",
    );
    // Silence findDOMNode export warning from @ant-design/compatible.
    const antDesignCompatPath = `${sep}@ant-design${sep}compatible${sep}`;
    const reactDomShim = resolve(__dirname, "lib", "react-dom-shim.js");
    config.plugins = config.plugins || [];
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^react-dom$/, (resource) => {
        if (resource.context?.includes(antDesignCompatPath)) {
          resource.request = reactDomShim;
        }
      }),
    );
    // These backend-only deps should never be bundled by Next.
    const emptyModule = resolve(__dirname, "lib", "webpack-empty.js");
    config.resolve.alias["micro-key-producer"] = emptyModule;
    config.resolve.alias["micro-key-producer/ssh.js"] = emptyModule;
    config.resolve.alias["micro-key-producer/utils.js"] = emptyModule;
    config.resolve.alias["dtrace-provider"] = emptyModule;
    config.devServer = {
      hot: true,
    };
    // Important: return the modified config
    return config;
  },
  // For i18n, see https://nextjs.org/docs/advanced-features/i18n-routing
  // We are doing this at all since it improves our Lighthouse accessibility score.
  i18n: {
    locales: ["en-US"],
    defaultLocale: "en-US",
  },
  poweredByHeader: false,
};

const withRspack = require("next-rspack");
// use NO_RSPACK to build without RSPACK.  This is useful on a machine with a lot
// of RAM (and patience) since it supports hot module reloading (so you don't have
// to refresh after making changes).

if (process.env.NO_RSPACK) {
  module.exports = config;
} else {
  module.exports = withRspack(config);
}
