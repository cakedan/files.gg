// Trust & safety states from the internal lookups (docs/redesign/contracts/milestone-4.md §2.4,
// §6.3, §10). Pure, so it is unit-tested with `node --test`.
//
//   files:  "safety": { "state": "ok | pending | hidden | removed | blocked", "reason": … },
//           "serve_inline": true
//   albums: "safety": { "state": "ok | hidden | removed", "reason": … }, "pending_count": n
//
// Everything fails closed: a lookup without `safety`, or with a state the Worker doesn't know, is
// `pending` (nothing is served, and nothing says why). Hash-matched CSAM never reaches the Worker:
// the API answers its lookup with 404, exactly like an unknown vanity.

export const FILE_STATES = Object.freeze(['ok', 'pending', 'hidden', 'removed', 'blocked']);
export const ALBUM_STATES = Object.freeze(['ok', 'hidden', 'removed']);
// The public reasons on a removed page (§2.4): `review` (hidden or held), `copyright`, `malware`,
// otherwise `terms`.
export const REMOVED_REASONS = Object.freeze(['review', 'terms', 'copyright', 'malware']);

const PENDING = Object.freeze({ state: 'pending', reason: null });


function removedReason(state, reason) {
  if (REMOVED_REASONS.includes(reason)) {
    return reason;
  }
  return (state === 'hidden') ? 'review' : 'terms';
}

function readSafety(data, states) {
  const safety = (data && data.safety && typeof(data.safety) === 'object') ? data.safety : null;
  if (!safety || !states.includes(safety.state)) {
    return PENDING;
  }
  if (safety.state === 'hidden' || safety.state === 'removed') {
    return { state: safety.state, reason: removedReason(safety.state, safety.reason) };
  }
  return { state: safety.state, reason: null };
}

// The file lookup's state, as { state, reason }. `reason` is the public reason for `hidden` and
// `removed` (defaulting to `review` and `terms`), else null.
export function fileSafety(data) {
  return readSafety(data, FILE_STATES);
}

// The album lookup's own state (ok, hidden or removed; `pending` when it's missing or unknown).
export function albumSafety(data) {
  return readSafety(data, ALBUM_STATES);
}

// Items that would be shown once they're `ok` (§6.3), or 0.
export function pendingCount(data) {
  const value = data && data.pending_count;
  return (typeof(value) === 'number' && Number.isSafeInteger(value) && value > 0) ? value : 0;
}

// False when the file's bytes may only be downloaded and its previews aren't served (§2.3: an
// image or video that couldn't be decoded for matching). Only an explicit `true` allows inline.
export function servesInline(data) {
  return !!data && data.serve_inline === true;
}

// The CDN's answer for a file in `state` (§10.2), or null when it may be served: `pending` and
// `blocked` look missing (404), `hidden` and `removed` are gone (410). Never cacheable.
export function cdnStateStatus(state) {
  switch (state) {
    case 'ok': return null;
    case 'hidden':
    case 'removed': return 410;
    default: return 404;
  }
}

// An album item's own state, when the payload or its items_access entry carries one. The API
// lists only `ok` items (§6.3); this is the Worker's guard if it ever sends another one.
export function itemShowable(item, itemAccess) {
  for (const source of [item, itemAccess]) {
    const safety = source && typeof(source) === 'object' && source.safety;
    if (safety && typeof(safety) === 'object' && safety.state !== 'ok' && safety.state !== 'flagged') {
      return false;
    }
  }
  return true;
}
