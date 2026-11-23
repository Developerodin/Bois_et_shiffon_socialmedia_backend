-- Meta ad accounts get their own provider (and login) apart from META, so ads_read is never added to Facebook Pages
-- logins. On its own: a value added with ALTER TYPE ... ADD VALUE can't be used in the transaction that adds it.
ALTER TYPE "IntegrationProvider" ADD VALUE 'META_ADS';
