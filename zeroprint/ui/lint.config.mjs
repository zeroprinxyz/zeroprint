// The linting that catches bugs rather than taste: a name that does not exist, and a value
// computed and never read. `node --test` says the logic is right; this says the file will run at
// all. A missing declaration shipped to the site once because nothing here was run before a
// deploy — "recipient is not defined", in the one form that moves money.
//
//   npx eslint -c zeroprint/ui/lint.config.mjs shade
//
// The repository's own eslint.config.mjs stays as it is: it also reports style this codebase
// chose on purpose, so it is not something a deploy can be gated on.
import globals from "globals";

export default [
  { ignores: ["**/dist/**", "**/dist-next/**", "**/dist-ipfs/**", "**/node_modules/**", "**/artifacts/**", "**/*.tmp.mjs"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.browser, ...globals.node } },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
    },
  },
];
