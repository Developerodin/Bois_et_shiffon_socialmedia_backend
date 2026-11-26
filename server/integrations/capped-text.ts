/** A response body longer than the caller's cap: the read stopped there, so the rest never reached memory. */
export class BodyTooLarge extends Error {
  constructor() {
    super("response body too large");
  }
}

/**
 * Reads a response body as UTF-8 text, at most `maxBytes`. The cap is checked on every chunk while streaming, so a
 * huge or endless body is cancelled once it passes the cap instead of being buffered first. Throws BodyTooLarge;
 * callers map it to their own error (AskCart's "too_large", the ECB client's fixed text).
 */
export async function cappedText(res: Response, maxBytes: number) {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
