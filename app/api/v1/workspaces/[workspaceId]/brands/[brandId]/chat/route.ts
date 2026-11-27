import { createOpenAI } from "@ai-sdk/openai";
import { Prisma } from "@prisma/client";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateId,
  isStepCount,
  streamText,
  toUIMessageStream,
  validateUIMessages,
  type UIMessage,
} from "ai";
import { fromAccessError, problemResponse } from "@/server/api/http-error";
import { authorizeBrandRoute, type BrandRouteParams } from "@/server/api/brand-route";
import { grade } from "@/server/ai/graders";
import { modelConfig } from "@/server/ai/model-config";
import { modelFor, ModelNotConfiguredError, type Tier } from "@/server/ai/models";
import { isOutOfCreditsText, logRun, OUT_OF_CREDITS } from "@/server/ai/provider";
import { hitRateLimit, limitKey } from "@/server/auth/rate-limit";
import { ChatBody, chatSystemPrompt, CHAT_PROMPT_VERSION, withPage, withPageNotes } from "@/server/chat/prompt";
import { chatTools } from "@/server/chat/tools";
import { activeTools, askedToSearch, hideOutputs, historyWindow } from "@/server/chat/turn";
import { prisma } from "@/server/db/prisma";

// Streaming replies with a few tool steps can take a while.
export const maxDuration = 300;

// ponytail: the model sees 20–40 recent messages (historyWindow) and the thread keeps the last 200; summarise older
// turns if people want longer memory.
const STORED_HISTORY = 200;
const CHAT_LIMIT = { limit: 30, windowMs: 10 * 60_000 }; // per person: each message costs OpenAI tokens

/** Latest conversation for this person and brand, so the panel restores it. */
export async function GET(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.read");
    if (scope instanceof Response) return scope;
    const thread = await prisma.chatThread.findFirst({
      where: { workspaceId: scope.workspaceId, brandId: scope.brandId, userId: scope.userId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, messages: true },
    });
    // A person who has lost a key since (crm.read, ads.read, analytics.read) keeps the thread but not the figures in it.
    if (thread) return Response.json({ thread: { ...thread, messages: hideOutputs(thread.messages as unknown as UIMessage[], scope.perms) } });
    return Response.json({ thread });
  } catch (error) {
    return fromAccessError(error);
  }
}

/** One turn: the client sends only its newest message; history comes from the database. */
export async function POST(request: Request, context: { params: Promise<BrandRouteParams> }) {
  try {
    const scope = await authorizeBrandRoute(request, context.params, "agents.read");
    if (scope instanceof Response) return scope;
    const body = ChatBody.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 422, detail: "That message is too long or malformed. Shorten it and try again." });
    }
    const rate = await hitRateLimit(limitKey("chat:user", scope.userId), CHAT_LIMIT.limit, CHAT_LIMIT.windowMs);
    if (!rate.allowed) {
      return problemResponse({ type: "https://api.brandpilot/errors/rate-limited", title: "Slow down", status: 429, detail: "Too many messages. Wait a few minutes." });
    }

    const existing = await prisma.chatThread.findUnique({ where: { id: body.data.id } });
    // Another person's (or brand's) conversation id: behave as if it doesn't exist.
    if (existing && (existing.userId !== scope.userId || existing.brandId !== scope.brandId)) {
      return problemResponse({ type: "https://api.brandpilot/errors/not-found", title: "Not found", status: 404 });
    }

    const brand = await prisma.brand.findFirstOrThrow({
      where: { id: scope.brandId, workspaceId: scope.workspaceId },
      select: { displayName: true, profile: { select: { websiteUrl: true } } },
    });
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const tools = { ...chatTools(scope), webSearch: openai.tools.webSearch() };
    const stored = (existing?.messages ?? []) as unknown as UIMessage[];
    // Regenerate resends a message we already have: answer it again from that point, don't append a copy.
    const resent = stored.findIndex((m) => m.id === (body.data.message as { id?: unknown }).id);
    const previous = resent === -1 ? stored : stored.slice(0, resent);
    // The page it was sent from is saved on the message (server-set, whitelisted): see withPageNotes.
    const messages = await validateUIMessages({ messages: [...previous, withPage(body.data.message, body.data.page, body.data.channel)], tools });

    let tier: Tier, model: string;
    try {
      ({ tier, model } = modelFor(await modelConfig(), "chat.turn"));
    } catch (error) {
      if (!(error instanceof ModelNotConfiguredError)) throw error;
      return problemResponse({ type: "https://api.brandpilot/errors/ai-not-configured", title: "AI isn't set up", status: 503, detail: error.message });
    }
    const started = Date.now();
    // Same ledger and per-call checks as agent calls (server/ai/provider.ts): one row per turn, with its cost and
    // grade; failed turns too. A streamed reply is already on screen, so a finding is recorded, not retried.
    const ctx = { workspaceId: scope.workspaceId, brandId: scope.brandId, userId: scope.userId, workflowId: "chat.turn", promptVersion: CHAT_PROMPT_VERSION };
    const system = chatSystemPrompt({ name: brand.displayName, website: brand.profile?.websiteUrl ?? null });
    // What the model reads: the saved data steps as GET shows them (hideOutputs, by the keys the person holds now). Only
    // this copy is redacted; `messages` keeps the figures, so the saved thread is never overwritten with the redactions.
    const history = hideOutputs(historyWindow(messages), scope.perms);
    const modelMessages = await convertToModelMessages(withPageNotes(history));
    // Web search off once the brand's data is in, data tools off past their per-turn caps: server/chat/turn.ts activeTools.
    const searchAsked = askedToSearch(messages.at(-1));
    const toolNames = Object.keys(tools) as (keyof typeof tools)[];
    const result = streamText({
      model: openai(model),
      system,
      messages: modelMessages,
      tools,
      prepareStep: ({ steps }) => {
        const active = activeTools(toolNames, { history, calls: steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)), searchAsked });
        return active ? { activeTools: active } : undefined;
      },
      stopWhen: isStepCount(6),
      onFinish: async ({ text, totalUsage, steps }) => {
        const findings = grade({
          workflowId: "chat.turn",
          system,
          // What it was given: the conversation and what our tools returned. Web results count as cited sources.
          prompt: JSON.stringify([history, steps.flatMap((s) => s.toolResults.map((r) => r.output))]),
          webSearch: true,
          output: { text, sources: steps.flatMap((s) => s.sources.flatMap((x) => (x.sourceType === "url" ? [x.url] : []))) },
        });
        await logRun(ctx, "openai", tier, model, "SUCCEEDED", started, {
          inputTokens: totalUsage.inputTokens,
          cachedInputTokens: totalUsage.inputTokenDetails?.cacheReadTokens,
          cacheWriteTokens: totalUsage.inputTokenDetails?.cacheWriteTokens,
          outputTokens: totalUsage.outputTokens,
          reasoningTokens: totalUsage.outputTokenDetails?.reasoningTokens,
          webSearchCalls: steps.flatMap((s) => s.toolCalls).filter((c) => c.toolName === "webSearch").length,
        }, undefined, findings);
      },
      onError: async ({ error }) => {
        await logRun(ctx, "openai", tier, model, "FAILED", started, undefined, String(error)).catch(() => {});
      },
    });
    result.consumeStream(); // finish and save even if the browser disconnects

    const firstText = messages.find((m) => m.role === "user")?.parts.find((p) => p.type === "text");
    const title = (firstText && "text" in firstText ? firstText.text : "New chat").slice(0, 80);

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        originalMessages: messages,
        // Without this the saved reply has an empty id, and two such replies share a React key.
        generateMessageId: generateId,
        onEnd: async ({ messages: all }) => {
          const data = { messages: all.slice(-STORED_HISTORY) as unknown as Prisma.InputJsonValue, title };
          // Never an upsert on the id alone: it would overwrite another person's thread that has the same id.
          const where = { id: body.data.id, userId: scope.userId, brandId: scope.brandId };
          const mine = await prisma.chatThread.updateMany({ where, data });
          if (mine.count === 0) {
            try {
              await prisma.chatThread.create({ data: { id: body.data.id, workspaceId: scope.workspaceId, brandId: scope.brandId, userId: scope.userId, ...data } });
            } catch (e) {
              // Two first saves raced: the other create won. Update ours if the thread is ours; someone else's id is dropped.
              if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
              await prisma.chatThread.updateMany({ where, data });
            }
          }
        },
        onError: (error) => {
          const text = error instanceof Error ? error.message : String(error);
          if (isOutOfCreditsText(text)) return `${OUT_OF_CREDITS}.`;
          console.error("[chat] turn failed", text.slice(0, 500));
          return "Something went wrong answering that. Try again.";
        },
      }),
    });
  } catch (error) {
    return fromAccessError(error);
  }
}
