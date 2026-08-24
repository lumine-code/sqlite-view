const js = require("@eslint/js");
const n = require("eslint-plugin-n");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

// Modules provided by the Lumine/Electron runtime rather than this package's own
// manifest, so they are not resolvable by eslint-plugin-n.
const runtimeModules = ["lumine"];

module.exports = [
  js.configs.recommended,
  n.configs["flat/recommended-script"],
  {
    // Flat config discovers JavaScript extensions only when they are named in
    // a files pattern; the query editor is authored in JSX.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx"],
    settings: {
      // The package runs inside the editor's bundled Node 24 runtime.
      n: {
        version: ">=24.0.0",
        tryExtensions: [".js", ".jsx", ".json", ".node", ".mjs", ".cjs"],
      },
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        lumine: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      "n/no-missing-require": ["error", { allowModules: runtimeModules }],
      "n/no-unpublished-require": ["error", { allowModules: runtimeModules }],
      "n/no-extraneous-require": ["error", { allowModules: runtimeModules }],
      // `navigator` here is Chromium's clipboard global, and node:sqlite is the
      // database API the editor's Node 24 runtime deliberately provides.
      "n/no-unsupported-features/node-builtins": ["error", { ignores: ["navigator", "sqlite"] }],
    },
  },
  {
    files: ["spec/**", "**/*-spec.js"],
    languageOptions: {
      globals: {
        ...globals.jasmine,
        advanceClock: "readonly",
        conditionPromise: "readonly",
        emitterEventPromise: "readonly",
        flushMicrotasks: "readonly",
        timeoutPromise: "readonly",
        waitForFrames: "readonly",
        waitsForPromise: "readonly",
      },
    },
    rules: {
      "n/no-missing-require": "off",
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  {
    files: ["eslint.config.js"],
    rules: {
      "n/no-unpublished-require": "off",
      "n/no-extraneous-require": "off",
    },
  },
  // Must be last: turns off rules that would conflict with Prettier.
  prettier,
];
