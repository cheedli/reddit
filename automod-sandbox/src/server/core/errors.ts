type ErrorLike = {
  code?: unknown;
  details?: unknown;
  message?: unknown;
  name?: unknown;
  stack?: unknown;
  cause?: unknown;
};

const DEFAULT_RATE_LIMIT_RETRY_MS = 5_000;
const DEFAULT_TRANSIENT_RETRY_MS = 1_000;

function asErrorLike(value: unknown): ErrorLike | null {
  return value !== null && typeof value === 'object' ? (value as ErrorLike) : null;
}

function formatField(label: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return `${label}=${String(value)}`;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    const fields = [
      formatField('name', error.name),
      formatField('message', error.message),
      formatField('code', asErrorLike(error)?.code),
      formatField('details', asErrorLike(error)?.details),
    ].filter(Boolean);
    return fields.length > 0 ? fields.join('; ') : String(error);
  }

  const value = asErrorLike(error);
  if (value) {
    const fields = [
      formatField('name', value.name),
      formatField('message', value.message),
      formatField('code', value.code),
      formatField('details', value.details),
    ].filter(Boolean);
    if (fields.length > 0) return fields.join('; ');
  }

  return String(error);
}

export function getRateLimitRetryMs(error: unknown): number | null {
  const formatted = formatError(error);
  if (!/rate\s*limit|ratelimit|resource_exhausted|status 8/i.test(formatted)) {
    return null;
  }

  const secondsMatch = formatted.match(/TimeString="(\d+)\s+seconds?"/i);
  if (secondsMatch?.[1]) return Number(secondsMatch[1]) * 1_000;

  const millisecondsMatch = formatted.match(/TimeString="(\d+)\s+milliseconds?"/i);
  if (millisecondsMatch?.[1]) return Number(millisecondsMatch[1]);

  return DEFAULT_RATE_LIMIT_RETRY_MS;
}

export function isRateLimitError(error: unknown): boolean {
  return getRateLimitRetryMs(error) !== null;
}

function getTransientRetryMs(error: unknown): number | null {
  const formatted = formatError(error);
  if (!/econnreset|socket hang up|unavailable|code=14|status 14/i.test(formatted)) {
    return null;
  }

  return DEFAULT_TRANSIENT_RETRY_MS;
}

function getRetryMs(error: unknown): number | null {
  return getRateLimitRetryMs(error) ?? getTransientRetryMs(error);
}

export function formatUserError(error: unknown): string {
  const retryMs = getRateLimitRetryMs(error);
  if (retryMs !== null) {
    return `Reddit is rate limiting this action. Wait ${Math.max(1, Math.ceil(retryMs / 1_000))} seconds and try again.`;
  }

  if (getTransientRetryMs(error) !== null) {
    return 'Reddit or Devvit dropped the connection while loading data. Try again in a few seconds.';
  }

  return formatError(error);
}

export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; paddingMs?: number } = {}
): Promise<T> {
  const attempts = options.attempts ?? 2;
  const paddingMs = options.paddingMs ?? 250;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const retryMs = getRetryMs(error);
      if (retryMs === null || attempt === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, retryMs + paddingMs));
    }
  }

  throw lastError;
}
