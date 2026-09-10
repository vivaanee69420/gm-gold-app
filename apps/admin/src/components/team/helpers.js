/** Two letters for an avatar: a person's initials, or the first of their email. */
export function initialsOf(source) {
  if (!source) return '?';
  const cleaned = String(source).split('@')[0].replace(/[._-]+/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}
