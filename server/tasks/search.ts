import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/prisma";
import { hitRateLimit } from "@/server/auth/rate-limit";
import { likeLiteral } from "@/server/catalog/products";
import { visibleTaskSql, type TaskViewer } from "@/server/tasks/access";
import { TaskError } from "@/server/tasks/errors";
import type { TaskScope } from "@/server/tasks/service";
import { SEARCH_MAX, SEARCH_MIN, type SearchResultDto, type SearchResultsDto } from "@/shared";

const PER_KIND = 5;
const none = (): SearchResultsDto => ({ tasks: [], projects: [], posts: [], products: [], campaigns: [] });

/**
 * Top-bar search on one brand (the route holds brand.read): up to 5 per kind, `ILIKE '%q%'` ranked by trigram
 * similarity, the five kinds read at once. Who sees what, each kind by its own list's rule:
 * - tasks: visibleTaskSql (tasks.read; a client only what they review or what sits in a shared project);
 * - projects: tasks.read, and a client only `clientVisible` ones (projects.ts projectWhere);
 * - posts, products, campaigns: brand.read, the key of their own list routes (content, products, campaigns), client
 *   reviewers included; the route already holds it, so these three always run.
 * Under SEARCH_MIN (3) characters (after trimming) answers empty without counting against the limit (trigrams need 3);
 * over 100 is a 400.
 * `only: "post"` (the task panel's post picker) reads posts alone, on its own 30-a-minute limit, so typing there
 * neither runs the other four queries nor uses up the top bar's searches.
 * ponytail: title trigram indexes aren't brand-scoped; add btree_gin (brandId, title gin_trgm_ops) if search slows on large catalogues.
 */
export async function searchBrand(scope: TaskScope, v: TaskViewer, raw: string, only?: "post"): Promise<SearchResultsDto> {
  const q = raw.trim();
  if (q.length < SEARCH_MIN) return none();
  if (q.length > SEARCH_MAX) throw new TaskError(`Search for at most ${SEARCH_MAX} characters`, 400);
  if (!(await hitRateLimit(`${only ? "search.posts" : "search"}:${scope.userId}`, 30, 60_000)).allowed) throw new TaskError("Too many searches. Wait a minute.", 429);

  const like = `%${likeLiteral(q)}%`;
  const brand = (a: string) => Prisma.sql`${Prisma.raw(a)}."workspaceId" = ${scope.workspaceId} AND ${Prisma.raw(a)}."brandId" = ${scope.brandId}`;
  const find = (kind: SearchResultDto["kind"], table: string, column: string, a: string, where: Prisma.Sql) => {
    const col = Prisma.raw(`${a}."${column}"`);
    return prisma
      .$queryRaw<{ id: string; title: string }[]>(
        Prisma.sql`SELECT ${Prisma.raw(a)}.id, ${col} AS title FROM ${Prisma.raw(`"${table}"`)} ${Prisma.raw(a)}
          WHERE ${where} AND ${col} ILIKE ${like}
          ORDER BY similarity(${col}, ${q}) DESC, ${Prisma.raw(a)}.id LIMIT ${Prisma.raw(String(PER_KIND))}`,
      )
      .then((rows) => rows.map((r) => ({ kind, id: r.id, title: r.title })));
  };
  const skip = Promise.resolve<SearchResultDto[]>([]);
  const findPosts = () => find("post", "ContentItem", "title", "c", Prisma.sql`${brand("c")} AND c.status <> 'CANCELLED'`);
  if (only === "post") return { ...none(), posts: await findPosts() };
  const [tasks, projects, posts, products, campaigns] = await Promise.all([
    v.canRead ? find("task", "Task", "title", "t", visibleTaskSql(v)) : skip,
    v.canRead ? find("project", "WorkProject", "name", "p", v.client ? Prisma.sql`${brand("p")} AND p."clientVisible"` : brand("p")) : skip,
    findPosts(),
    find("product", "Product", "title", "pr", Prisma.sql`${brand("pr")} AND pr."archivedAt" IS NULL`),
    find("campaign", "Campaign", "name", "ca", Prisma.sql`${brand("ca")} AND ca."archivedAt" IS NULL`),
  ]);
  return { tasks, projects, posts, products, campaigns };
}
