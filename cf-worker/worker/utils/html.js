// Minimal HTML rendering with the same escaping Mithril's server renderer used, so the
// files.gg pages are byte-for-byte what they were (see test/fixtures/stable-pages.mithril.json).

const VOID_TAGS = new Set(['link', 'meta']);

// Text content: &, < and > are escaped (quotes are safe outside attributes).
export function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Attribute values are always double-quoted, so " is escaped as well.
export function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, '&quot;');
}

// Attributes whose value is null or undefined are left out, like Mithril did.
export function renderAttributes(attributes) {
  let result = '';
  for (const [name, value] of Object.entries(attributes || {})) {
    if (value === null || value === undefined) {
      continue;
    }
    result += ` ${name}="${escapeAttribute(value)}"`;
  }
  return result;
}

// `children` is already-rendered HTML; pass `text` to escape plain text instead.
export function element(tag, attributes, { children = '', text } = {}) {
  const content = (text === null || text === undefined) ? children : escapeText(text);
  if (VOID_TAGS.has(tag) && !content) {
    return `<${tag}${renderAttributes(attributes)}>`;
  }
  return `<${tag}${renderAttributes(attributes)}>${content}</${tag}>`;
}
