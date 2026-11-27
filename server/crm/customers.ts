import type { Customer, Prisma } from "@prisma/client";
import { z } from "zod";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { brandWhere, changed, checkCrmLinks, checkOwner, crmAudit, type CrmScope, type Db, dayOf, dayString, invalid, notFound } from "@/server/crm/common";
import { normaliseIdentity } from "@/server/crm/identity";
import { prisma } from "@/server/db/prisma";
import { quoteTotals, quoteDiscount, quoteLines, loadQuote } from "@/server/quotes/quotes";
import { PublishingError, TX } from "@/server/services/publishing";
import { fromCursor, toCursor } from "@/server/tasks/cursor";
import { isUniqueViolation } from "@/server/tasks/errors";
import { CRM_LIMITS, MANUAL_IDENTITY_KINDS, quoteNumber, type CustomerDto, type CustomerNoteDto, type CustomerRow, type IdentityKind } from "@/shared";

/**
 * Customer records (plan 2026-11-27-crm, Task A3), crm.manage for everything (checked by the routes). A customer is a
 * person, optionally under a company; identities (email, phone; channel ids in Phases B/C) are unique per brand and
 * kind. Access is audited by id: a view once per user, customer and hour; a search with its result count only; a list
 * page once per user and hour. Bulk reading is rate limited (plan review, Security 7).
 */
const HOUR = 3_600_000;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD");
const id = z.string().min(1).max(40);
const text = (max: number) => z.string().trim().max(max);

export const IdentityInput = z.object({ kind: z.enum(MANUAL_IDENTITY_KINDS), value: z.string().max(CRM_LIMITS.identity) });
const fields = {
  displayName: text(CRM_LIMITS.name).min(1, "Give the customer a name"),
  role: text(CRM_LIMITS.role).nullable().optional(),
  language: z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "A language like fr or en-GB").max(CRM_LIMITS.language).nullable().optional(),
  companyId: id.nullable().optional(),
  ownerId: id.nullable().optional(),
  nextAction: text(CRM_LIMITS.nextAction).nullable().optional(),
  nextActionDue: day.nullable().optional(),
};
export const CustomerCreate = z.object({ ...fields, identities: z.array(IdentityInput).max(10).default([]) });
export const CustomerPatch = z.object({ ...fields, displayName: fields.displayName.optional(), updatedAt: z.string().datetime() });
export const NoteInput = z.object({ text: text(CRM_LIMITS.note).min(1, "Write the note first") });
export const ListQuery = z.object({ q: z.string().max(100).optional(), companyId: id.optional(), cursor: z.string().max(400).optional() });
const Cursor = z.object({ at: z.string().datetime(), id: z.string() });

type Row = Customer & { company: { id: string; name: string } | null };
const toRow = (c: Row): CustomerRow => ({
  id: c.id,
  displayName: c.displayName,
  role: c.role,
  company: c.company,
  ownerId: c.ownerId,
  nextAction: c.nextAction,
  nextActionDue: dayString(c.nextActionDue),
  lastActivityAt: c.lastActivityAt.toISOString(),
});
const withCompany = { company: { select: { id: true, name: true } } } as const;

export async function loadCustomer(db: Db, s: { workspaceId: string; brandId: string }, customerId: string) {
  const c = await db.customer.findFirst({ where: { id: customerId, ...brandWhere(s) } });
  if (!c) throw notFound("Customer");
  return c;
}

/**
 * A page of customers, latest activity first (50, cursor), or with `q` (≥ 2 characters) a search on the name and
 * identity values (20 results, 60 a minute per person, audited with the count only).
 */
export async function listCustomers(s: CrmScope, query: z.infer<typeof ListQuery>): Promise<{ customers: CustomerRow[]; nextCursor: string | null }> {
  const w = brandWhere(s);
  const q = query.q?.trim();
  if (q !== undefined && q !== "") {
    if (q.length < CRM_LIMITS.searchMin) throw invalid(`Type at least ${CRM_LIMITS.searchMin} characters to search`, "crm.searchShort");
    if (!(await hitRateLimit(`crm-search:${s.userId}`, 60, 60_000)).allowed) throw new PublishingError("Too many searches. Wait a minute and try again.", 429);
    // Prisma's `contains` passes % and _ through to ILIKE: typed ones match themselves.
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    const rows = await prisma.customer.findMany({
      where: { ...w, OR: [{ displayName: { contains: escaped, mode: "insensitive" } }, { identities: { some: { value: { contains: escaped, mode: "insensitive" } } } }] },
      include: withCompany,
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      take: CRM_LIMITS.searchResults,
    });
    await crmAudit(prisma, s, "customer.searched", "Customer", "-", { results: rows.length });
    return { customers: rows.map(toRow), nextCursor: null };
  }
  if (!(await hitRateLimit(`crm-list:${s.userId}`, 120, HOUR)).allowed) throw new PublishingError("Too many pages of customers this hour. Try again later.", 429);
  const after = query.cursor ? fromCursor(Cursor, query.cursor) : null;
  const rows = await prisma.customer.findMany({
    where: {
      ...w,
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(after ? { OR: [{ lastActivityAt: { lt: new Date(after.at) } }, { lastActivityAt: new Date(after.at), id: { lt: after.id } }] } : {}),
    },
    include: withCompany,
    orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    take: CRM_LIMITS.pageSize + 1,
  });
  const page = rows.slice(0, CRM_LIMITS.pageSize);
  // A list page is audited once per person and hour (the count only), so paging out every customer leaves a trace.
  if ((await hitRateLimit(`crm-listed:${s.userId}:${s.brandId}`, 1, HOUR)).allowed) await crmAudit(prisma, s, "customer.listed", "Customer", "-", { results: page.length });
  const last = page.at(-1);
  return { customers: page.map(toRow), nextCursor: rows.length > page.length && last ? toCursor({ at: last.lastActivityAt.toISOString(), id: last.id }) : null };
}

/** Customer page sections that come from other tasks (conversations, deals) plug in here; see getCustomer. */
export type CustomerExtras = { conversations: CustomerDto["conversations"]; deals: CustomerDto["deals"] };
let extras: (s: CrmScope, customerId: string) => Promise<CustomerExtras> = async () => ({ conversations: null, deals: [] });
/** Registered by server/crm/conversations.ts and deals.ts (kept out of this module's imports to avoid a cycle). */
export function registerCustomerExtras(fn: typeof extras) {
  extras = fn;
}

const NOTE_DELETE_MS = 24 * HOUR;
export const toNoteDto = (n: { id: string; authorId: string | null; text: string; createdAt: Date }, userId: string, now = Date.now()): CustomerNoteDto => ({
  id: n.id,
  authorId: n.authorId,
  text: n.text,
  createdAt: n.createdAt.toISOString(),
  mine: n.authorId === userId,
  deletable: n.authorId === userId && now - n.createdAt.getTime() < NOTE_DELETE_MS,
});

/** One customer's page. Conversations only for inbox.read holders (Decision 17). The view is audited once per hour. */
export async function getCustomer(s: CrmScope, customerId: string): Promise<CustomerDto> {
  const c = await prisma.customer.findFirst({
    where: { id: customerId, ...brandWhere(s) },
    include: { ...withCompany, identities: { orderBy: { createdAt: "asc" } }, notes: { orderBy: { createdAt: "desc" }, take: 200 }, quotes: { orderBy: { updatedAt: "desc" }, take: 50 } },
  });
  if (!c) throw notFound("Customer");
  if ((await hitRateLimit(`crm-viewed:${s.userId}:${c.id}`, 1, HOUR)).allowed) await crmAudit(prisma, s, "customer.viewed", "Customer", c.id);
  const more = await extras(s, c.id);
  return {
    ...toRow(c),
    language: c.language,
    source: c.source,
    identities: c.identities.map((i) => ({ id: i.id, kind: i.kind, value: i.value })),
    notes: c.notes.map((n) => toNoteDto(n, s.userId)),
    quotes: c.quotes.map((q) => ({ id: q.id, number: quoteNumber(q.number), status: q.status, total: quoteTotals(quoteLines(q.lines), quoteDiscount(q.discount), q.currency).total, currency: q.currency, updatedAt: q.updatedAt.toISOString() })),
    deals: more.deals,
    conversations: more.conversations,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** Adds identities to a customer; one already on another customer is a 409 naming that customer (crm.manage sees it anyway). */
async function addIdentities(tx: Prisma.TransactionClient, s: CrmScope, customerId: string, list: { kind: IdentityKind; value: string }[]) {
  for (const i of list) {
    const value = normaliseIdentity(i.kind, i.value);
    const taken = await tx.customerIdentity.findFirst({ where: { brandId: s.brandId, kind: i.kind, value }, select: { customerId: true, customer: { select: { displayName: true } } } });
    if (taken) {
      if (taken.customerId === customerId) continue;
      throw new PublishingError("Another customer already has this contact detail", 409, "crm.identityTaken", { customerId: taken.customerId, customerName: taken.customer.displayName });
    }
    await tx.customerIdentity.create({ data: { ...brandWhere(s), customerId, kind: i.kind, value } });
  }
}

/** A unique clash that raced the check above: answered like the check would have. */
async function identityRace<T>(s: CrmScope, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (isUniqueViolation(e)) throw new PublishingError("Another customer already has this contact detail", 409, "crm.identityTaken");
    throw e;
  }
}

export async function createCustomer(s: CrmScope, input: z.infer<typeof CustomerCreate>, source: "MANUAL" | "QUOTE" = "MANUAL", db?: Prisma.TransactionClient) {
  const run = async (tx: Prisma.TransactionClient) => {
    await checkCrmLinks(tx, s, { companyId: input.companyId });
    await checkOwner(tx, s, input.ownerId, "crm.manage");
    const c = await tx.customer.create({
      data: {
        ...brandWhere(s), displayName: input.displayName, role: input.role || null, language: input.language || null, companyId: input.companyId ?? null, ownerId: input.ownerId ?? null,
        nextAction: input.nextAction || null, nextActionDue: dayOf(input.nextActionDue) ?? null, source,
      },
    });
    await addIdentities(tx, s, c.id, input.identities);
    await crmAudit(tx, s, "customer.created", "Customer", c.id, { source, identities: input.identities.length });
    return c;
  };
  const c = db ? await run(db) : await identityRace(s, () => prisma.$transaction(run, TX));
  return c;
}

/** Field edits on the `updatedAt` read (409 when someone saved in between). */
export async function updateCustomer(s: CrmScope, customerId: string, patch: z.infer<typeof CustomerPatch>) {
  const { updatedAt, ...rest } = patch;
  await prisma.$transaction(async (tx) => {
    await checkCrmLinks(tx, s, { companyId: rest.companyId });
    await checkOwner(tx, s, rest.ownerId, "crm.manage");
    const blank = (v: string | null | undefined) => (v === undefined ? undefined : v || null);
    const { count } = await tx.customer.updateMany({
      where: { id: customerId, ...brandWhere(s), updatedAt: new Date(updatedAt) },
      data: {
        displayName: rest.displayName, role: blank(rest.role), language: blank(rest.language), companyId: rest.companyId, ownerId: rest.ownerId,
        nextAction: blank(rest.nextAction), nextActionDue: dayOf(rest.nextActionDue), lastActivityAt: new Date(),
      },
    });
    if (!count) {
      await loadCustomer(tx, s, customerId);
      throw changed("This customer");
    }
    await crmAudit(tx, s, "customer.edited", "Customer", customerId, { fields: Object.keys(rest) });
  }, TX);
  return getCustomer(s, customerId);
}

export async function addIdentity(s: CrmScope, customerId: string, input: z.infer<typeof IdentityInput>) {
  await identityRace(s, () =>
    prisma.$transaction(async (tx) => {
      await loadCustomer(tx, s, customerId);
      await addIdentities(tx, s, customerId, [input]);
      await tx.customer.update({ where: { id: customerId }, data: { lastActivityAt: new Date() } });
      await crmAudit(tx, s, "customer.identity.added", "Customer", customerId, { kind: input.kind });
    }, TX),
  );
  return getCustomer(s, customerId);
}

export async function removeIdentity(s: CrmScope, customerId: string, identityId: string) {
  await prisma.$transaction(async (tx) => {
    await loadCustomer(tx, s, customerId);
    const { count } = await tx.customerIdentity.deleteMany({ where: { id: identityId, customerId, ...brandWhere(s) } });
    if (!count) throw notFound("Contact detail");
    await crmAudit(tx, s, "customer.identity.removed", "Customer", customerId);
  }, TX);
  return getCustomer(s, customerId);
}

export async function addNote(s: CrmScope, customerId: string, input: z.infer<typeof NoteInput>) {
  const note = await prisma.$transaction(async (tx) => {
    await loadCustomer(tx, s, customerId);
    const n = await tx.customerNote.create({ data: { ...brandWhere(s), customerId, authorId: s.userId, text: input.text } });
    await tx.customer.update({ where: { id: customerId }, data: { lastActivityAt: n.createdAt } });
    await crmAudit(tx, s, "customer.note.added", "Customer", customerId, { noteId: n.id, length: input.text.length });
    return n;
  }, TX);
  return toNoteDto(note, s.userId);
}

/** Notes are append-only: the author may delete theirs within 24 h; anyone else's is 403. */
export async function deleteNote(s: CrmScope, customerId: string, noteId: string, now = Date.now()) {
  const n = await prisma.customerNote.findFirst({ where: { id: noteId, customerId, ...brandWhere(s) } });
  if (!n) throw notFound("Note");
  if (n.authorId !== s.userId) throw new PublishingError("Only the person who wrote a note can delete it", 403, "crm.noteNotYours");
  if (now - n.createdAt.getTime() >= NOTE_DELETE_MS) throw new PublishingError("Notes can be deleted only in the first 24 hours", 409, "crm.noteTooOld");
  await prisma.$transaction([prisma.customerNote.delete({ where: { id: n.id } }), crmAudit(prisma, s, "customer.note.deleted", "Customer", customerId, { noteId: n.id })]);
}

/** A quote's customer: link an existing one, save the quote's contact as a new one (source QUOTE), or unlink. */
export const QuoteCustomerInput = z.union([z.object({ customerId: id.nullable() }), z.object({ create: z.literal(true) })]);
export async function setQuoteCustomer(s: CrmScope, quoteId: string, input: z.infer<typeof QuoteCustomerInput>) {
  const q = await loadQuote(s, quoteId);
  await identityRace(s, () =>
    prisma.$transaction(async (tx) => {
      let customerId: string | null;
      if ("create" in input) {
        if (!q.contactName?.trim()) throw invalid("Add the contact's name to the quote first", "crm.noContact");
        const email = q.contactEmail?.trim();
        // The quote's email may already be a customer's: say so rather than make a second one.
        if (email) {
          const taken = await tx.customerIdentity.findFirst({ where: { brandId: s.brandId, kind: "EMAIL", value: normaliseIdentity("EMAIL", email) }, select: { customerId: true, customer: { select: { displayName: true } } } });
          if (taken) throw new PublishingError("A customer already has this email: link the quote to them", 409, "crm.identityTaken", { customerId: taken.customerId, customerName: taken.customer.displayName });
        }
        const c = await createCustomer(s, { displayName: q.contactName.trim().slice(0, CRM_LIMITS.name), identities: email ? [{ kind: "EMAIL", value: email }] : [] }, "QUOTE", tx);
        customerId = c.id;
      } else {
        customerId = input.customerId;
        await checkCrmLinks(tx, s, { customerId });
      }
      const { count } = await tx.quote.updateMany({ where: { id: q.id, ...brandWhere(s) }, data: { customerId } });
      if (!count) throw notFound("Quote");
      if (customerId) await tx.customer.update({ where: { id: customerId }, data: { lastActivityAt: new Date() } });
      await crmAudit(tx, s, "quote.customer", "Quote", q.id, { customerId, created: "create" in input });
    }, TX),
  );
  return loadQuote(s, quoteId);
}
