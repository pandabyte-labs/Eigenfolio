const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const reactRefresh = require("eslint-plugin-react-refresh");
const reactHooks = require("eslint-plugin-react-hooks");

/** @type {import("eslint").Linter.FlatConfig[]} */
module.exports = [
  {
    ignores: ["dist/**", "build/**", "coverage/**", "node_modules/**", "src/vendor/**"],
  },
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-refresh": reactRefresh,
      "react-hooks": reactHooks,
    },
    rules: {
      ...(tsPlugin.configs && tsPlugin.configs.recommended
        ? tsPlugin.configs.recommended.rules
        : {}),
      ...(reactHooks.configs && reactHooks.configs.recommended
        ? reactHooks.configs.recommended.rules
        : {}),
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
];
