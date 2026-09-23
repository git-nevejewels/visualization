// src/common/v1/utils/httpClient.js
//
// Minimal shared JSON GET helper for direct service-to-service calls, bypassing the BFF.
// logContext.correlationId/sessionId are forwarded as X-Correlation-Id/X-Session-Id headers
// when present, to keep cross-service trace correlation intact.
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
