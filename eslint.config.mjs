import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * A linter for the defects `tsc` cannot see.
 *
 * Every bug this project has recorded failed SILENTLY — a promise nobody
 * awaited, a rejection nobody handled, a value that quietly became
 * "[object Object]". Type checking passes on all of them. So the rules held
 * as errors here are the ones that catch unobserved async work; formatting is
 * deliberately not policed, because reformatting churn would make this fork
 * harder to rebase onto upstream.
 *
 * Where a rule is switched off below, the reason is written down. "Too noisy"
 * on its own is not a reason — either the rule finds a real class of defect
 * (then it stays on and the debt is marked inline) or it does not apply to
 * this codebase (then it goes off, with the argument recorded).
 */
export default tseslint.config(
  {
    // Build output, coverage reports, and dependencies are not ours to lint.
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Not `tsconfig.json` — its `rootDir: ./src` excludes the test suite,
        // which would leave every test file unlintable. See
        // tsconfig.eslint.json.
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The silent-failure rules. These are why this config exists: an
      // un-awaited host RPC is precisely how a Telegram action has gone
      // missing with nothing in the log.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // An unused parameter is usually a signature that drifted from its
      // caller. Underscore-prefixed names are the documented opt-out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // OFF: an `async` function with no `await` is how this codebase
      // conforms to host interfaces that require a promise-returning handler.
      // The rule flags 171 of them and every one is intentional; it measures
      // interface shape, not a defect.
      "@typescript-eslint/require-await": "off",

      // `String(payload.field)` on a `Record<string, unknown>` value that
      // turns out to be an object silently renders "[object Object]" in a
      // Telegram message. Call sites must go through the `str()` helper in
      // ./src/coerce.ts, which narrows to primitives and logs+falls back
      // otherwise.
      "@typescript-eslint/no-base-to-string": "error",
    },
  },
  {
    // Tests reach into internals and stub host APIs on purpose: `any` in a
    // fake host is the point, and an unbound method reference is how a spy
    // gets asserted on. Erroring here would punish the suite for doing its job.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // `unbound-method` fires on every `form.onChange`-style prop handed to a
    // Paperclip UI component. That is the framework's calling convention, not
    // a lost `this`.
    files: ["src/ui/**/*.tsx"],
    rules: { "@typescript-eslint/unbound-method": "off" },
  },
  {
    // Plain-JS tooling (this config, the mutation checker) sits outside the
    // TypeScript project, so type-aware rules have no types to consult. This
    // must come AFTER the block that sets `parserOptions.project`: flat
    // config is last-match-wins, and clearing the project is the whole point.
    files: ["**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { project: null },
      // These run under Node (`node scripts/mutation-check.mjs`).
      globals: globals.node,
    },
  },
);
