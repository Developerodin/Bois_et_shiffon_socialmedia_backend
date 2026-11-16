/** Runs once when the Next server starts. A non-https AUTH_URL in production would mint http links and insecure cookies. */
export function register() {
  if (process.env.NODE_ENV === "production" && !process.env.AUTH_URL?.startsWith("https://")) {
    throw new Error("AUTH_URL must be an https:// URL in production");
  }
}
