// Request policy is independent of transport, account identity and payload data.
const TRANSIENT_HTTP = new Set([500, 502, 503, 504]);
const DEFAULT_COOLDOWN_MS = 60000;
const DEFAULT_RETRY_MS = 1000;

function positiveDuration(value) {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 2 ? Math.ceil(value) : 0;
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
}

function retryAfterMs(headers, now) {
  const value = String(headerValue(headers, 'retry-after') ?? '').trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return positiveDuration(Number(value) * 1000);
  if (/^[A-Za-z]{3,9},/.test(value)) return positiveDuration(Date.parse(value) - now);
  return 0;
}

function retryInfoMs(error) {
  let longest = 0;
  for (const detail of Array.isArray(error?.details) ? error.details : []) {
    if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') continue;
    const duration = detail.retryDelay;
    let ms = 0;
    if (typeof duration === 'string' && /^\d+(?:\.\d{1,9})?s$/.test(duration)) {
      ms = Number(duration.slice(0, -1)) * 1000;
    } else if (duration && typeof duration === 'object') {
      const seconds = String(duration.seconds ?? '0');
      const nanos = duration.nanos ?? 0;
      if (/^\d+$/.test(seconds) && Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9) {
        ms = Number(seconds) * 1000 + nanos / 1e6;
      }
    }
    longest = Math.max(longest, positiveDuration(ms));
  }
  return longest;
}

export function classifyHttpFailure(status, text, headers, now = Date.now()) {
  let data;
  try { data = JSON.parse(text); } catch {}
  const error = data?.error ?? data?.response?.error;
  const wait = Math.max(retryAfterMs(headers, now), retryInfoMs(error));
  const quota = status === 429 && /quota/i.test(String(error?.message ?? ''));
  const code = status === 401 || status === 403 ? 'AUTH'
    : status === 429 ? (quota ? 'QUOTA_EXCEEDED' : 'RATE_LIMIT')
    : status === 408 || status === 504 ? 'TIMEOUT'
    : status >= 500 ? 'SERVER' : 'INVALID_REQUEST';
  return {
    code,
    retryable: TRANSIENT_HTTP.has(status),
    cooldownMs: status === 429 ? Math.max(DEFAULT_COOLDOWN_MS, wait) : 0,
    suspendAccount: status === 401 || status === 403,
    retryDelayMs: Math.max(DEFAULT_RETRY_MS, wait),
  };
}

export async function waitForRetry(ms, signal) {
  if (signal?.aborted) throw signal.reason;
  // Node timers wrap past 2^31-1. Chunk long, valid server waits instead of
  // shortening them; callers may choose not to retry for a long server delay.
  let remaining = Math.max(0, ms);
  do {
    const duration = Math.min(remaining, 2147483647);
    await new Promise((resolve, reject) => {
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error !== undefined) reject(error); else resolve();
      };
      const onAbort = () => finish(signal.reason ?? new Error('Request aborted'));
      signal?.addEventListener('abort', onAbort, {once:true});
      if (signal?.aborted) { onAbort(); return; }
      timer = setTimeout(() => finish(), duration);
    });
    remaining -= duration;
  } while (remaining > 0);
}
