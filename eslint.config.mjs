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
// apps/server (shared code lives in ./shared, a copy kept in step with the web repo). One block per folder depth, since how many "../" leave the app
// depends on where the file sits (ESLint keeps only the last matching block's options for a rule). npm workspaces
// also link the other apps into node_modules by package name ("web-frontend/…" resolves to apps/web), and "@/../" or
// "./../" climb out as well. no-restricted-imports doesn't see import(), so no-restricted-syntax repeats the escapes
// for it (esquery regexes can't hold "/", hence \x2F).
const LEAVES = "Leaves apps/server: import from inside the app, or from @/shared.";
const boundary = (depth) => {
  const escapes = [`^(\\./)?(\\.\\./){${depth + 1},}`, "^@/\\.\\.(/|$)", "^(web-frontend|mobile-app)(/|$)"];
  return {
    files: [`${"*/".repeat(depth)}*.${SOURCES}`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/components", "@/components/*"], message: "Website code: the Server doesn't import the Web Frontend." },
            ...escapes.map((regex) => ({ regex, message: LEAVES })),
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: `ImportExpression[source.value=/${escapes.join("|").replaceAll("/", "\\x2F")}/]`, message: LEAVES },
      ],
    },
  };
};

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
      "dist/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
