/** FTS helpers shared by the indexer and the query layer. */

export function normalizeSearchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_/.:#-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildFtsQuery(query, { conjunction = false } = {}) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return "";
  const terms = [...new Set(normalized.split(" ").filter(Boolean))].slice(0, 12);
  return terms
    .map((term) => `"${term.replace(/"/g, "")}"*`)
    .join(conjunction ? " AND " : " OR ");
}

export function searchTextFor(parts) {
  const raw = parts.filter(Boolean).join(" ");
  return `${raw}\n${normalizeSearchText(raw)}`;
}
