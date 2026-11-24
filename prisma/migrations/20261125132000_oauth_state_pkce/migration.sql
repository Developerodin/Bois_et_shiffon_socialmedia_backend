-- PKCE verifier kept with a connect state (AskCart per-brand connect).
ALTER TABLE "OAuthStateTransaction" ADD COLUMN "codeVerifier" TEXT;
