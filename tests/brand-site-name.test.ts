import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ brand: { updateMany: vi.fn() }, workProject: { updateMany: vi.fn() } }));
vi.mock("@/server/db/prisma", () => ({ prisma: db }));

import { adoptSiteName } from "@/server/research/brand-summary";

const scope = { workspaceId: "w1", brandId: "b1" };
const home = { url: "https://boisetchiffons.fr", title: "Boisetchiffons", description: null, text: "Bois & Chiffons — meubles. © 2026 Bois & Chiffons" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  db.brand.updateMany.mockResolvedValue({ count: 1 });
  db.workProject.updateMany.mockResolvedValue({ count: 1 });
});

describe("adoptSiteName", () => {
  it("replaces a guessed name with the site's own, and the default project still named the old way", async () => {
    expect(await adoptSiteName(scope, "Boisetchiffons", "Bois & Chiffons", home)).toBe(true);
    expect(db.brand.updateMany).toHaveBeenCalledWith({ where: { id: "b1", workspaceId: "w1", nameGuessed: true }, data: { displayName: "Bois & Chiffons" } });
    expect(db.workProject.updateMany).toHaveBeenCalledWith({ where: { brandId: "b1", workspaceId: "w1", requestId: "brand-default", name: "Boisetchiffons" }, data: { name: "Bois & Chiffons" } });
  });

  it("leaves a name a person chose (nothing matches nameGuessed), and never uses one that isn't on the homepage", async () => {
    db.brand.updateMany.mockResolvedValue({ count: 0 });
    expect(await adoptSiteName(scope, "B&C", "Bois & Chiffons", home)).toBe(false);
    expect(db.workProject.updateMany).not.toHaveBeenCalled();
    vi.clearAllMocks();
    expect(await adoptSiteName(scope, "Boisetchiffons", "Wood & Cloth Ltd", home)).toBe(false);
    expect(await adoptSiteName(scope, "Boisetchiffons", "", home)).toBe(false);
    expect(db.brand.updateMany).not.toHaveBeenCalled();
  });
});
