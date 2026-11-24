-- crm.manage (customer records, notes and quotes) goes to the built-in Owner, Admin, Project admin and Manager rows of
-- every workspace, as SYSTEM_ROLES (permissions.catalog.ts) seeds new ones; the same shape as 20261125090000_crm_ads_read.
-- Owner and Admin read theirs from code, but Prisma filters read the stored copy, so their rows get the key too. Matched
-- by isSystem + slug: a custom role with a built-in slug, and every other role, is left alone. Re-run safe: only missing
-- keys are appended.
UPDATE "Role"
SET "permissions" = "permissions" || ARRAY(
      SELECT k FROM unnest(ARRAY['crm.manage']::TEXT[]) WITH ORDINALITY AS a(k, n)
      WHERE k <> ALL("permissions") ORDER BY n
    ),
    "updatedAt" = now()
WHERE "isSystem" AND "slug" IN ('owner', 'admin', 'project-admin', 'manager')
  AND NOT ("permissions" @> ARRAY['crm.manage']::TEXT[]);
