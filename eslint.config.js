import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(...tseslint.configs.recommended, {
  files: ["public/**/*.js"],
  languageOptions: { globals: globals.browser },
});
