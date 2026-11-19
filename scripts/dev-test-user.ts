/**
 * Dev only: a test login for browser checks (Playwright), added as an owner to every workspace a platform admin
 * belongs to. Never touches anyone else's password, unlike the seed.
 * Credentials: DEV_TEST_EMAIL / DEV_TEST_PASSWORD in .env; a missing password is generated and appended there.
 * Run: npm run dev:test-user
 */
import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/server/db/prisma";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to add a test login in production");
  const email = (process.env.DEV_TEST_EMAIL ?? "dev-test@espanda.test").trim().toLowerCase();
  let password = process.env.DEV_TEST_PASSWORD;
  if (!password) {
    password = randomBytes(18).toString("base64url");
    appendFileSync(".env", `\nDEV_TEST_EMAIL=${email}\nDEV_TEST_PASSWORD=${password}\n`);
  }

  const workspaceIds = [
    ...new Set(
      (await prisma.workspaceMember.findMany({ where: { user: { isPlatformAdmin: true } }, select: { workspaceId: true } })).map((m) => m.workspaceId),
    ),
  ];
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: await bcrypt.hash(password, 12), status: "ACTIVE", deletedAt: null },
    create: { email, name: "Dev test", passwordHash: await bcrypt.hash(password, 12), status: "ACTIVE" },
  });
  for (const workspaceId of workspaceIds) {
    const owner = await prisma.role.findUnique({ where: { workspaceId_slug: { workspaceId, slug: "owner" } } });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      update: { role: WorkspaceRole.OWNER, roleId: owner?.id },
      create: { workspaceId, userId: user.id, role: WorkspaceRole.OWNER, roleId: owner?.id },
    });
  }
  console.log(`Test login ${email} is an owner in ${workspaceIds.length} workspace(s). Password is in .env.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
