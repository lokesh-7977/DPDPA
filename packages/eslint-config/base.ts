import type { ESLint, Linter } from "eslint";
import babelParser from "@babel/eslint-parser";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import onlyWarn from "eslint-plugin-only-warn";

/**
 * A shared ESLint configuration for the repository.
 */
export const config: Linter.Config[] = [
  js.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ["@babel/preset-typescript"],
        },
      },
    },
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
  {
    // Lint TypeScript sources (ESLint only picks up .js/.mjs/.cjs by default).
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      // The Babel parser can't see TS types; `tsc --noEmit` checks both instead.
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
  {
    // .tsx: TypeScript + JSX.
    files: ["**/*.tsx"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ["@babel/preset-typescript"],
          parserOpts: { plugins: ["jsx"] },
        },
      },
    },
  },
  {
    plugins: {
      // The package works by side effect (it downgrades errors to warnings); its
      // bundled types don't describe a Plugin object, hence the cast.
      onlyWarn: onlyWarn as unknown as ESLint.Plugin,
    },
  },
  {
    ignores: ["dist/**"],
  },
];
