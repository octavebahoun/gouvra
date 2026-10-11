import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "coverage", "playwright-report", "test-results", "src/lib/api/schema.d.ts"] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
      jsxA11y.flatConfigs.strict,
    ],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "error",
        {
          allowConstantExport: true,
          // Design-system modules co-locate variants/hooks with their component on purpose.
          allowExportNames: [
            "buttonVariants",
            "badgeVariants",
            "controlClass",
            "useField",
            "useFieldWiring",
            "useAnnounce",
            "isTerminal",
          ],
        },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.test.{ts,tsx}", "src/tests/**", "e2e/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: ["e2e/**", "playwright.config.ts", "vite.config.ts"],
    languageOptions: { globals: globals.node },
  },
);
