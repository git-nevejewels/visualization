// src/common/v1/utils/httpClient.js
//
// Minimal shared JSON GET helper for direct service-to-service calls (Merchandising, MDM — never
// through the BFF, which only fronts frontend-initiated traffic). Deliberately just this one
// function: this repo has no need for a full HTTP client abstraction (axios wrapping, retries,
// etc.) — queryExecutor.js's own retry/circuit-breaker machinery is for the DB, not these calls.
// Extracted here once a second entity (image_request) needed the exact same call base_design's
// module already had inlined — see GAPS.md.
//
// logContext.correlationId/sessionId are forwarded as X-Correlation-Id/X-Session-Id headers when
// present — same convention confirmed in D:\work\cad\src\entities\pdp\v1\services\
// stonePriceService.js's own outbound call, added here 2026-09-18 after realizing this repo's own
// outbound calls never propagated them, breaking cross-service trace correlation (see GAPS.md).
async function fetchJson(url, logContext = {}) {
  const { correlationId, sessionId } = logContext;
  const headers = {
    ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
    ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
  };
  const res = await fetch(url, Object.keys(headers).length > 0 ? { headers } : undefined);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`${res.status} for ${url}: ${body?.message || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

module.exports = { fetchJson };
