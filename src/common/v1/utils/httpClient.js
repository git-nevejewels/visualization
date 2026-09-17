// src/common/v1/utils/httpClient.js
//
// Minimal shared JSON GET helper for direct service-to-service calls (Merchandising, MDM — never
// through the BFF, which only fronts frontend-initiated traffic). Deliberately just this one
// function: this repo has no need for a full HTTP client abstraction (axios wrapping, retries,
// etc.) — queryExecutor.js's own retry/circuit-breaker machinery is for the DB, not these calls.
// Extracted here once a second entity (image_request) needed the exact same call base_design's
// module already had inlined — see GAPS.md.
async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`${res.status} for ${url}: ${body?.message || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Added 2026-09-16 for the Visualization -> CAD notification (see ARCHITECTURE.md's "CAD <->
// Visualization integration") — CAD's own generic update() endpoint is a plain PUT with a JSON
// body, so this is fetchJson's mirror image rather than a new abstraction.
async function putJson(url, payload) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`${res.status} for ${url}: ${body?.message || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

module.exports = { fetchJson, putJson };
