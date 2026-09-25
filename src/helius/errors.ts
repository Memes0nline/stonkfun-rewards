import type { HeliusFailure, HeliusFailureCategory } from './types.js';

const actions: Record<HeliusFailureCategory, HeliusFailure['action']> = {
  authentication: 'check_api_key', entitlement: 'check_plan_access', access_denied: 'check_plan_access',
  invalid_parameter: 'check_query', method_unavailable: 'check_method_availability', transient: 'retry',
  provider_error: 'inspect_provider_response', malformed_response: 'inspect_provider_response',
  response_too_large: 'check_query', sensitive_response: 'inspect_provider_response',
  cancelled: 'resume', request_budget: 'resume', page_budget: 'resume', cursor_cycle: 'restart_range', consumer_failure: 'fix_consumer',
};
export function failure(category: HeliusFailureCategory, details: Partial<Pick<HeliusFailure, 'httpStatus' | 'rpcCode' | 'reason' | 'message'>> = {}): HeliusFailure {
  return { category, retryable: category === 'transient', action: actions[category], ...details };
}
export class SafeFailure extends Error {
  constructor(readonly failure: HeliusFailure) { super(failure.category); }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** A provider's own error text as the user may see it: printable characters only, with URLs, UUID-shaped keys and
 * key or token assignments removed, collapsed and cut to 300 characters. Empty text is none. */
export function providerMessage(text: string): string | undefined {
  const cleaned = text.replace(/[^\x20-\x7e]+/g, ' ').replace(/https?:\/\/\S*/gi, '[url]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted]')
    .replace(/\b(api[-_ ]?key|token|secret|password|authorization)\b(\s*[=:]\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
  return cleaned === '' ? undefined : cleaned;
}
/** Provider messages select a finite category. Only a plan, quota, access or unrecognized refusal keeps the sanitized text,
 * for the user to read; a key rejection or a transient failure never does. */
export function providerFailure(status: number, body: unknown): HeliusFailure {
  const root = object(body);
  const rpc = object(root?.error);
  const code = rpc?.code;
  const rpcCode = typeof code === 'number' && Number.isSafeInteger(code) ? code : undefined;
  const message = typeof rpc?.message === 'string' ? rpc.message
    : typeof root?.error === 'string' ? root.error : typeof root?.message === 'string' ? root.message : '';
  const details = { httpStatus: status, ...(rpcCode === undefined ? {} : { rpcCode }) };
  const text = providerMessage(message);
  const words = text === undefined ? {} : { message: text };
  if (status === 401 || /(?:invalid|missing|revoked|expired)\s+(?:api[ -]?)?key|api[ -]?key\s+(?:is\s+)?(?:invalid|missing|revoked|expired)/i.test(message)) {
    return failure('authentication', details);
  }
  if (/\b(?:upgrade|requires?|only available)\b.{0,80}\b(?:plan|subscription|tier)\b|not\s+(?:available|enabled|supported)\s+(?:on|for)\s+(?:your|this|the)\s+plan|plan\s+(?:does\s+not|doesn't)\s+(?:support|include)|feature\s+access\s+(?:denied|required)/i.test(message)) {
    return failure('entitlement', { ...details, ...words });
  }
  if (status === 400 || rpcCode === -32602) return failure('invalid_parameter', { ...details, ...words });
  if (rpcCode === -32601) return failure('method_unavailable', { ...details, ...words });
  if (status === 429 || rpcCode === -32005 || /rate\s*limit|too many requests/i.test(message)) return failure('transient', { ...details, reason: 'rate_limit' });
  if ([408, 425].includes(status) || status >= 500 || rpcCode === -32603 || /temporarily unavailable|service unavailable|timed?\s*out/i.test(message)) return failure('transient', details);
  if (status === 403) return failure('access_denied', { ...details, ...words });
  return failure('provider_error', { ...details, ...words });
}
export function hasRpcError(value: unknown): boolean {
  const root = object(value);
  return root !== undefined && 'error' in root;
}
