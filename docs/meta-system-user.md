# Meta Ads with a System User token

A personal Meta login gives a token that expires after 60 days, so the ad numbers stop until someone signs in
again. A System User token from Business Manager doesn't expire. Once pasted in Connections → Meta Ads → "Use a
system user token", it takes over from the personal login for the ad accounts it can see.

## Steps for the business's admin (Business Manager)

1. Open **Business settings → Users → System users** and add a system user (role: Employee is enough).
2. **Assign assets** to it: add **only your own ad account**, with "View performance" (read) access. The token
   connects every ad account the system user can see, so don't assign accounts that aren't this brand's.
3. **Apps**: make sure our app is added to the business (Business settings → Accounts → Apps), then assign the app
   to the system user.
4. Select the system user → **Generate new token**: pick our app, tick **ads_read**, and set the expiry to
   **Never**.
5. Copy the token and paste it in Connections → Meta Ads → **Use a system user token**. It is checked with Meta
   (our app, a system user, no expiry, ads_read) and stored encrypted; it is never shown again.

## What the platform does with it

- The ad accounts it sees are connected (or the personal login's connections replaced in place); the chosen ad
  account keeps syncing, and the 60-day reconnect warning stops.
- A later personal login doesn't replace a working system token. If the system token stops working (revoked, or the
  ad account taken away), the sync reports it, and a personal login or a new token replaces it.
- Disconnect removes it like any connection.

Refusals say why: another app's token, a personal token, a token that expires, one without ads_read, or one that
sees no ad account.
