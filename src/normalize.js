/**
 * Small, pure helpers that turn raw page strings into clean JSON values.
 */

/** Collapses whitespace and returns null for empty / placeholder values. */
function cleanText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text || text === '-' || text.toLowerCase() === 'n/a') return null;
  return text;
}

/** "$1,299.99" -> 1299.99, anything unparsable -> null. */
function parsePrice(value) {
  const text = cleanText(value);
  if (!text) return null;
  const match = text.replace(/,/g, '').match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** "4.7 (3)" -> { rating: 4.7, count: 3 }. */
function parseRating(value) {
  const text = cleanText(value);
  if (!text) return { rating: null, count: null };
  const rating = text.match(/^(\d+(?:\.\d+)?)/);
  const count = text.match(/\((\d+)\)/);
  return {
    rating: rating ? Number(rating[1]) : null,
    count: count ? Number(count[1]) : null,
  };
}

/** Maps a free-text stock label to in_stock / out_of_stock / pre_order / null. */
function normalizeAvailability(value) {
  const text = (cleanText(value) || '').toLowerCase();
  if (!text) return null;
  if (/pre-?order/.test(text)) return 'pre_order';
  if (/out of stock|sold out|unavailable|coming soon/.test(text)) return 'out_of_stock';
  if (/in stock|available/.test(text)) return 'in_stock';
  return null;
}

/** Returns unique, non-empty values while keeping their original order. */
function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

module.exports = { cleanText, parsePrice, parseRating, normalizeAvailability, uniq };
