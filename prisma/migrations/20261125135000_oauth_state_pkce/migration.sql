-- PKCE verifier and the typed shop kept with a connect state (AskCart per-brand connect).
ALTER TABLE "OAuthStateTransaction" ADD COLUMN "codeVerifier" TEXT;
ALTER TABLE "OAuthStateTransaction" ADD COLUMN "shop" TEXT;
