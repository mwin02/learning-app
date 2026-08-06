import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent scratch space, not project source: skill helper scripts and the
    // git worktrees agents check out under .claude/worktrees (each a full
    // second copy of src/, which would double every finding).
    ".claude/**",
  ]),
  {
    // App Router route files are Server Components (none in this repo carry
    // "use client"). react-hooks/purity models client render, where a call
    // like Date.now() is unstable across re-renders; a server component runs
    // once per request, so the rule reports only false positives here.
    files: ["src/app/**/{page,layout,template,loading,error,not-found}.tsx"],
    rules: { "react-hooks/purity": "off" },
  },
]);

export default eslintConfig;
