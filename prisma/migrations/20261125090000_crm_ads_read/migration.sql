-- crm.read (orders and sales) and ads.read (ad spend, results and budgets) go to the built-in Owner, Admin, Project
-- admin and Manager rows of every workspace, as SYSTEM_ROLES (permissions.catalog.ts) seeds new ones. Owner and Admin
-- read theirs from code, but Prisma filters read the stored copy, so their rows get the keys too. Matched by isSystem +
-- slug: a custom role with a built-in slug, and every other role, is left alone. Re-run safe: only missing keys are
-- appended, so a row never holds a key twice.
UPDATE "Role"
SET "permissions" = "permissions" || ARRAY(
      SELECT k FROM unnest(ARRAY['crm.read', 'ads.read']::TEXT[]) WITH ORDINALITY AS a(k, n)
      WHERE k <> ALL("permissions") ORDER BY n
    ),
    "updatedAt" = now()
WHERE "isSystem" AND "slug" IN ('owner', 'admin', 'project-admin', 'manager')
  AND NOT ("permissions" @> ARRAY['crm.read', 'ads.read']::TEXT[]);
