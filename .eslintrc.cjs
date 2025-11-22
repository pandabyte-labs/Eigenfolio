module.exports = {
  root: true,
  env: {
    browser: true,
    es2021: true
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module"
  },
  plugins: ["@typescript-eslint", "react-refresh"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    "react-refresh/only-export-components": ["warn", { allowConstantExport: true }]
  }
};
