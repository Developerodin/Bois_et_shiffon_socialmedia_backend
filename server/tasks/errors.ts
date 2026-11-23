import { problemResponse } from "@/server/api/http-error";

/** A refusal from the task services; routes answer it with taskProblem (like PublishingError). */
export class TaskError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    /** Stable string clients can switch on. */ readonly code?: string,
  ) {
    super(message);
  }
}

/** The problem response for a TaskError, else null (the caller falls back to fromAccessError). */
export function taskProblem(error: unknown) {
  if (!(error instanceof TaskError)) return null;
  return problemResponse({ type: "https://api.brandpilot/errors/tasks", title: error.message, status: error.status, detail: error.message, code: error.code });
}
