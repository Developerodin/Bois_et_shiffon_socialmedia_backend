// Copies server/shared to the web and mobile repos and stamps all three with the same .hash.
// Run from the server repo: npm run sync:shared. The repos must sit side by side (../web, ../mobile).
import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const source = "shared";
const targets = [join(process.env.WEB_DIR ?? "../web", "shared"), join(process.env.MOBILE_DIR ?? "../mobile", "src/shared")];

// Line endings are normalised so a git checkout with autocrlf does not change the hash.
const lf = (p) => Buffer.from(readFileSync(p).toString("latin1").replace(/\r\n/g, "\n"), "latin1");

function files(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name !== ".hash")
    .map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll("\\", "/"))
    .sort();
}

const hash = createHash("sha256");
for (const f of files(source)) hash.update(f).update("\0").update(lf(join(source, f))).update("\0");
const digest = hash.digest("hex");

writeFileSync(join(source, ".hash"), digest + "\n");
for (const target of targets) {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}
console.log(digest);
