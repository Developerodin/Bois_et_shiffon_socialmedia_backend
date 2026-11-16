/** Liveness for the load balancer / uptime check: answers without touching the database. */
export function GET() {
  return Response.json({ ok: true });
}
