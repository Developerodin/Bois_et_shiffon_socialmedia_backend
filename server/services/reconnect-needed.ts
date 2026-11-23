/** A refused or expired token: the connection needs reconnecting. Its own module with no imports, so import cycles
 * through the connections service can never leave it undefined (instanceof then throws in the Next bundle). */
export class ReconnectNeeded extends Error {}
