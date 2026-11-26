// Titles are data written by agents and people: one line, no control characters, short.
// Zero-width and bidi characters go too, so a title can't hide or reorder text.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g;

export const cleanTitle = (t: string) => t.replace(UNSAFE, " ").trim().slice(0, 100) || "(untitled)";

// The same character rules as cleanTitle with the caller's length, for untrusted text that must survive whole
// (a URL must keep every character for urlKey) or is longer than a title (a finding's detail). Empty stays empty.
export const cleanText = (t: string, max: number) => t.replace(UNSAFE, " ").trim().slice(0, max);
