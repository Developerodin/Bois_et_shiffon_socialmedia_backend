import type { Company } from "@prisma/client";
import { z } from "zod";
import { brandWhere, changed, checkOwner, crmAudit, type CrmScope, notFound } from "@/server/crm/common";
import { prisma } from "@/server/db/prisma";
import { TX } from "@/server/services/publishing";
import { CRM_LIMITS, type CompanyDto } from "@/shared";

/** Companies (plan 2026-11-27-crm, Task A3): an optional parent of customers (trade buyers, studios). crm.manage. */
const website = z
  .string()
  .trim()
  .max(CRM_LIMITS.website)
  .refine((v) => {
    try {
      return ["http:", "https:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, "A website starts with http:// or https://");
const fields = { name: z.string().trim().min(1, "Give the company a name").max(CRM_LIMITS.name), website: website.nullable().optional(), ownerId: z.string().min(1).max(40).nullable().optional() };
export const CompanyCreate = z.object(fields);
export const CompanyPatch = z.object({ ...fields, name: fields.name.optional(), updatedAt: z.string().datetime() });

const toDto = (c: Company & { _count: { customers: number } }): CompanyDto => ({
  id: c.id,
  name: c.name,
  website: c.website,
  ownerId: c.ownerId,
  customers: c._count.customers,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});
const counted = { _count: { select: { customers: true } } } as const;

/** ponytail: the first 500 by name; a picker with search once a brand keeps more companies. */
export async function listCompanies(s: CrmScope) {
  const rows = await prisma.company.findMany({ where: brandWhere(s), include: counted, orderBy: [{ name: "asc" }, { id: "asc" }], take: 500 });
  return rows.map(toDto);
}

export async function getCompany(s: CrmScope, companyId: string) {
  const c = await prisma.company.findFirst({ where: { id: companyId, ...brandWhere(s) }, include: counted });
  if (!c) throw notFound("Company");
  return toDto(c);
}

export async function createCompany(s: CrmScope, input: z.infer<typeof CompanyCreate>) {
  const c = await prisma.$transaction(async (tx) => {
    await checkOwner(tx, s, input.ownerId, "crm.manage");
    const row = await tx.company.create({ data: { ...brandWhere(s), name: input.name, website: input.website || null, ownerId: input.ownerId ?? null }, include: counted });
    await crmAudit(tx, s, "company.created", "Company", row.id);
    return row;
  }, TX);
  return toDto(c);
}

export async function updateCompany(s: CrmScope, companyId: string, patch: z.infer<typeof CompanyPatch>) {
  const { updatedAt, ...rest } = patch;
  await prisma.$transaction(async (tx) => {
    await checkOwner(tx, s, rest.ownerId, "crm.manage");
    const { count } = await tx.company.updateMany({
      where: { id: companyId, ...brandWhere(s), updatedAt: new Date(updatedAt) },
      data: { name: rest.name, website: rest.website === undefined ? undefined : rest.website || null, ownerId: rest.ownerId },
    });
    if (!count) {
      if (!(await tx.company.findFirst({ where: { id: companyId, ...brandWhere(s) }, select: { id: true } }))) throw notFound("Company");
      throw changed("This company");
    }
    await crmAudit(tx, s, "company.edited", "Company", companyId, { fields: Object.keys(rest) });
  }, TX);
  return getCompany(s, companyId);
}
