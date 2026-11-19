import { prisma } from "@/server/db/prisma";
import { PlaceListing } from "@/server/integrations/places";
import { contentLanguageOf, workLanguageOf } from "@/server/research/brand-summary";
import { languageName, type ContentLanguage } from "@/shared";

/**
 * Loads exactly one brand's context for one agent run (DEC-023, REQ-PLAT-003).
 * Agents never receive another brand's data: this is the only loader they get.
 */
export type BrandContext = {
  workspaceId: string;
  brandId: string;
  displayName: string;
  websiteUrl: string | null;
  /** Owner's own words when there's no website (what they sell, where). */
  about: string | null;
  location: string | null;
  /** The Google Maps listing the owner picked in onboarding, if any. */
  place: PlaceListing | null;
  voiceSummary: string | null;
  pillars: unknown;
  locales: unknown;
  /** The team working language (what agents write for the team); null = not chosen, agents keep their defaults. */
  workLanguage: ContentLanguage | null;
  /** The post language (what customers read), from locales; null = not chosen. */
  contentLanguage: ContentLanguage | null;
};

export async function loadBrandContext(
  workspaceId: string,
  brandId: string,
): Promise<BrandContext> {
  const brand = await prisma.brand.findFirstOrThrow({
    where: { id: brandId, workspaceId, status: "ACTIVE" },
    include: { profile: true },
  });
  return {
    workspaceId,
    brandId,
    displayName: brand.displayName,
    websiteUrl: brand.profile?.websiteUrl ?? null,
    about: brand.profile?.about ?? null,
    location: brand.profile?.location ?? null,
    place: PlaceListing.safeParse(brand.profile?.place).data ?? null,
    voiceSummary: brand.profile?.voiceSummary ?? null,
    pillars: brand.profile?.pillars ?? null,
    locales: brand.profile?.locales ?? null,
    workLanguage: workLanguageOf(brand.profile?.preferences),
    contentLanguage: contentLanguageOf(brand.profile?.locales),
  };
}

/**
 * The line every agent call ends its system prompt with, once the team has a working language: which text is for
 * customers (post language) and which for the team. Search questions count as customer-facing, so GEO keeps measuring
 * the market's own searches. Fixed text from the two codes only: the same for a brand until someone changes a
 * language (which resets that brand's prompt cache once). null = no team language yet, prompts unchanged.
 */
export function languageLine(brand: Pick<BrandContext, "workLanguage" | "contentLanguage">): string | null {
  if (!brand.workLanguage) return null;
  const post = brand.contentLanguage ? languageName(brand.contentLanguage) : "the brand's language";
  return (
    `Language: write customer-facing text (captions, post and story text, CTAs, hashtags, replies to customers, and ` +
    `questions shoppers would type into search or AI assistants) in ${post}. Write everything else for the team ` +
    `(titles, angles, reasons, summaries, notes, findings, plans, documents) in ${languageName(brand.workLanguage)}. ` +
    `Quote source text as it is.`
  );
}
