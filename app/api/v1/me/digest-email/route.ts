import { z } from "zod";
import { problemResponse } from "@/server/api/http-error";
import { requestUserId } from "@/server/auth/request-user";
import { prisma } from "@/server/db/prisma";

const unauthorized = () => problemResponse({ type: "https://api.brandpilot/errors/unauthorized", title: "Unauthorized", status: 401, detail: "Sign in required" });

/** Whether the caller gets the weekly digest by email (opt-in; the in-app digest is for everyone). */
export async function GET(request: Request) {
  const userId = await requestUserId(request);
  if (!userId) return unauthorized();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { digestEmail: true } });
  return Response.json({ email: !!user?.digestEmail });
}

/** PUT { email: boolean }: opt in or out, for every workspace. */
export async function PUT(request: Request) {
  const userId = await requestUserId(request);
  if (!userId) return unauthorized();
  const body = z.object({ email: z.boolean() }).safeParse(await request.json().catch(() => null));
  if (!body.success) return problemResponse({ type: "https://api.brandpilot/errors/validation", title: "Invalid request", status: 400, detail: "email must be true or false" });
  await prisma.user.update({ where: { id: userId }, data: { digestEmail: body.data.email } });
  return Response.json({ email: body.data.email });
}
