// Titles are data written by agents and people: one line, no control characters, short.
// Zero-width and bidi characters go too, so a title can't hide or reorder text.
export const cleanTitle = (t: string) =>
  t.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, " ").trim().slice(0, 100) || "(untitled)";
