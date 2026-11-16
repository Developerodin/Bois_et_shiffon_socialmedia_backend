import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const SOURCES = "{ts,tsx,js,jsx,mjs}";

// The Server takes nothing from the Web Frontend: no components, and no relative import that climbs out of
// apps/server (shared code lives in @espanda/shared). One block per folder depth, since how many "../" leave the app
// depends on where the file sits (ESLint keeps only the last matching block's options for a rule).
const boundary = (depth) => ({
  files: [`${"*/".repeat(depth)}*.${SOURCES}`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          { group: ["@/components", "@/components/*"], message: "Website code: the Server doesn't import the Web Frontend." },
          { regex: `^(\\.\\./){${depth + 1},}`, message: "Leaves apps/server: import from inside the app, or from @espanda/shared." },
        ],
      },
    ],
  },
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  ...Array.from({ length: 12 }, (_, depth) => boundary(depth)),
  // These tests fake Prisma with in-memory tables whose rows and where-clauses have no fixed shape.
  {
    files: ["tests/stories-by-hand.test.ts", "tests/stories-publish.test.ts", "tests/stories-save.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
