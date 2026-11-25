// Who owns a file or album, and where it may be shown (docs/redesign/contracts/milestone-6.md
// §8.8, §10.6-§10.8). Read from the internal lookups (v6):
//
//   files and albums:  "owner_user_id": "…" | null, "served_on": "files.gg" | "custom",
//                      "owner_state": "active" | "pending_deletion"
//   domains:           { "domain": { "id", "hostname", "user_id", "scope": "own" | "any", "serving" } }
//
// Pure, so it is unit-tested with `node --test`.

// True when the owner's account is waiting for deletion: the content looks missing everywhere
// (only a staff grant still serves it, on the CDN only). `active`, or no field at all (anonymous
// content), is active; any other value fails closed.
export function ownerPendingDeletion(data) {
  const state = data ? data.owner_state : undefined;
  return !(state === undefined || state === null || state === 'active');
}

// True when the owner's domain-only mode is in effect (§10.6): files.gg shows the content as
// missing, and cdn.files.gg needs a signed URL. Only the exact value counts: it's branding, not
// privacy, so an unknown value serves as before.
export function servedOnCustom(data) {
  return !!data && data.served_on === 'custom';
}

// True when the domain lookup says the hostname may be served right now (`serving: true` exactly).
export function domainServing(domain) {
  return !!domain && typeof(domain) === 'object' && domain.serving === true;
}

function idOf(value) {
  if (typeof(value) === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return (typeof(value) === 'string' && value) ? value : null;
}

// §10.8 step 4: a domain with `scope: "any"` shows anyone's content; any other scope ("own", and
// anything unknown) only its owner's. Anonymous content (`owner_user_id: null`) never matches.
export function domainAllows(domain, data) {
  if (!domain || typeof(domain) !== 'object') {
    return false;
  }
  if (domain.scope === 'any') {
    return true;
  }
  const owner = idOf(data && data.owner_user_id);
  const user = idOf(domain.user_id);
  return owner !== null && user !== null && owner === user;
}
