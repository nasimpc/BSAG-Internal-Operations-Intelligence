import { Buffer } from 'node:buffer';

import pLimit from 'p-limit';
import type { Logger } from 'pino';
import { request, type Dispatcher } from 'undici';

import { logger as defaultLogger } from '../shared/logger.js';
import { SERVER_INFO } from '../version.js';

const DEFAULT_MAX_TRANSIENT_RETRIES = 2;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 100;
const DEFAULT_PER_HOST_CONCURRENCY = 2;
const DEFAULT_NETWORK_ERROR_CODE = 'SOURCE_NETWORK_ERROR';
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface BaseFetchPolicy {
  expectedTypes: readonly string[];
  maxBytes: number;
  timeoutMs: number;
}

export type TextFetchPolicy = BaseFetchPolicy;

export type BinaryFetchPolicy = BaseFetchPolicy;

export interface FetchResponse<T> {
  body: T;
  finalUrl: URL;
  contentType: string;
  statusCode: number;
  attempts: number;
  redirectCount: number;
}

export interface SourceHttpClientOptions {
  allowedSourceUrls: readonly string[];
  dispatcher?: Dispatcher;
  logger?: Logger;
  sleeper?: (delayMs: number) => Promise<void>;
  jitter?: () => number;
  userAgent?: string;
  perHostConcurrency?: number;
  maxTransientRetries?: number;
  maxRedirects?: number;
  backoffBaseMs?: number;
}

export class SourceHttpClientError extends Error {
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    options: {
      cause?: unknown;
      statusCode?: number;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'SourceHttpClientError';
    this.statusCode = options.statusCode;
  }
}

export class SourceHttpClient {
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #logger: Logger;
  readonly #sleeper: ((delayMs: number) => Promise<void>) | undefined;
  readonly #jitter: (() => number) | undefined;
  readonly #userAgent: string;
  readonly #perHostConcurrency: number;
  readonly #maxTransientRetries: number;
  readonly #maxRedirects: number;
  readonly #backoffBaseMs: number;
  readonly #hostQueues = new Map<string, ReturnType<typeof pLimit>>();

  constructor(options: SourceHttpClientOptions) {
    this.#allowedHosts = new Set(
      options.allowedSourceUrls.map((sourceUrl) =>
        new URL(sourceUrl).host.toLowerCase(),
      ),
    );
    this.#dispatcher = options.dispatcher;
    this.#logger = options.logger ?? defaultLogger;
    this.#sleeper = options.sleeper;
    this.#jitter = options.jitter;
    this.#userAgent =
      options.userAgent ??
      `${SERVER_INFO.name}/${SERVER_INFO.version} public-source-client`;
    this.#perHostConcurrency =
      options.perHostConcurrency ?? DEFAULT_PER_HOST_CONCURRENCY;
    this.#maxTransientRetries =
      options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
    this.#maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.#backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  }

  async getText(
    url: URL,
    policy: TextFetchPolicy,
  ): Promise<FetchResponse<string>> {
    const result = await this.getBytes(url, policy);

    return {
      ...result,
      body: new TextDecoder().decode(result.body),
    };
  }

  async getBytes(
    url: URL,
    policy: BinaryFetchPolicy,
  ): Promise<FetchResponse<Uint8Array>> {
    let attempt = 0;

    while (attempt <= this.#maxTransientRetries) {
      attempt += 1;

      try {
        const result = await this.fetchWithRedirects(url, policy);

        this.#logger.info({
          event: 'source_http_success',
          url: result.finalUrl.toString(),
          statusCode: result.statusCode,
          contentType: result.contentType,
          byteCount: result.body.byteLength,
          attempts: attempt,
          redirectCount: result.redirectCount,
        });

        return {
          ...result,
          attempts: attempt,
        };
      } catch (rawError) {
        const error = this.normalizeError(rawError);

        if (!error.retryable || attempt > this.#maxTransientRetries) {
          this.#logger.warn({
            event: 'source_http_failure',
            url: url.toString(),
            attempts: attempt,
            code: error.code,
            statusCode: error.statusCode,
            error: error.message,
          });
          throw error;
        }

        const delayMs =
          this.#backoffBaseMs * 2 ** (attempt - 1) + this.jitterValue();

        this.#logger.warn({
          event: 'source_http_retry',
          url: url.toString(),
          attempts: attempt,
          code: error.code,
          statusCode: error.statusCode,
          delayMs,
          error: error.message,
        });
        await this.sleep(delayMs);
      }
    }

    throw new SourceHttpClientError(
      'Request failed',
      'SOURCE_REQUEST_FAILED',
      false,
    );
  }

  private async fetchWithRedirects(
    initialUrl: URL,
    policy: BaseFetchPolicy,
  ): Promise<Omit<FetchResponse<Uint8Array>, 'attempts'>> {
    let currentUrl = new URL(initialUrl);
    let redirectCount = 0;

    this.assertAllowedHost(
      currentUrl,
      'HOST_NOT_ALLOWED',
      'Requested URL must use the allow-listed host',
    );

    for (;;) {
      const response = await this.dispatchRequest(currentUrl, policy);

      if (REDIRECT_STATUS_CODES.has(response.statusCode)) {
        if (redirectCount >= this.#maxRedirects) {
          throw new SourceHttpClientError(
            'Too many redirects',
            'SOURCE_TOO_MANY_REDIRECTS',
            false,
          );
        }

        const location = getHeader(response.headers.location);

        if (!location) {
          throw new SourceHttpClientError(
            'Redirect response did not include a location header',
            'SOURCE_REDIRECT_LOCATION_MISSING',
            false,
          );
        }

        currentUrl = new URL(location, currentUrl);
        this.assertAllowedHost(
          currentUrl,
          'REDIRECT_HOST_NOT_ALLOWED',
          'Redirect host must stay on the allow-listed host',
        );
        redirectCount += 1;
        continue;
      }

      if (TRANSIENT_STATUS_CODES.has(response.statusCode)) {
        throw new SourceHttpClientError(
          'Transient upstream status ' + String(response.statusCode),
          'SOURCE_HTTP_STATUS',
          true,
          { statusCode: response.statusCode },
        );
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new SourceHttpClientError(
          'Unexpected upstream status ' + String(response.statusCode),
          'SOURCE_HTTP_STATUS',
          false,
          { statusCode: response.statusCode },
        );
      }

      const contentType = normalizeMimeType(
        getHeader(response.headers['content-type']),
      );
      this.assertExpectedContentType(contentType, policy.expectedTypes);
      this.assertContentLength(
        getHeader(response.headers['content-length']),
        policy.maxBytes,
      );

      const body = await this.readBody(response.body, policy.maxBytes);

      return {
        body,
        finalUrl: currentUrl,
        contentType,
        statusCode: response.statusCode,
        redirectCount,
      };
    }
  }

  private async dispatchRequest(url: URL, policy: BaseFetchPolicy) {
    return this.limitFor(url.host)(async () => {
      const requestOptions = {
        method: 'GET' as const,
        signal: AbortSignal.timeout(policy.timeoutMs),
        headers: {
          accept: policy.expectedTypes.join(', '),
          'user-agent': this.#userAgent,
        },
      };

      if (this.#dispatcher) {
        return request(url, {
          ...requestOptions,
          dispatcher: this.#dispatcher,
        });
      }

      return request(url, requestOptions);
    });
  }

  private limitFor(host: string) {
    const normalizedHost = host.toLowerCase();
    let limit = this.#hostQueues.get(normalizedHost);

    if (!limit) {
      limit = pLimit(this.#perHostConcurrency);
      this.#hostQueues.set(normalizedHost, limit);
    }

    return limit;
  }

  private assertAllowedHost(url: URL, code: string, message: string): void {
    if (!this.#allowedHosts.has(url.host.toLowerCase())) {
      throw new SourceHttpClientError(message, code, false);
    }
  }

  private assertExpectedContentType(
    contentType: string,
    expectedTypes: readonly string[],
  ): void {
    const normalizedExpected = expectedTypes.map((value) =>
      normalizeMimeType(value),
    );

    if (!normalizedExpected.includes(contentType)) {
      throw new SourceHttpClientError(
        `Unexpected content type "${contentType}"`,
        'SOURCE_CONTENT_TYPE',
        false,
      );
    }
  }

  private assertContentLength(
    contentLengthHeader: string | undefined,
    maxBytes: number,
  ): void {
    if (!contentLengthHeader) {
      return;
    }

    const declaredBytes = Number(contentLengthHeader);

    if (!Number.isFinite(declaredBytes)) {
      return;
    }

    if (declaredBytes > maxBytes) {
      throw new SourceHttpClientError(
        'Response content-length ' +
          String(declaredBytes) +
          ' exceeds limit ' +
          String(maxBytes),
        'SOURCE_RESPONSE_TOO_LARGE',
        false,
      );
    }
  }

  private async readBody(
    body: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    for await (const chunk of body) {
      totalBytes += chunk.byteLength;

      if (totalBytes > maxBytes) {
        throw new SourceHttpClientError(
          'Response byte limit ' + String(maxBytes) + ' exceeded',
          'SOURCE_RESPONSE_TOO_LARGE',
          false,
        );
      }

      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  private normalizeError(rawError: unknown): SourceHttpClientError {
    if (rawError instanceof SourceHttpClientError) {
      return rawError;
    }

    if (rawError instanceof Error) {
      if (
        rawError.name === 'AbortError' ||
        rawError.name === 'TimeoutError' ||
        rawError.message.includes('This operation was aborted')
      ) {
        return new SourceHttpClientError(
          'Request timed out',
          'SOURCE_TIMEOUT',
          true,
          { cause: rawError },
        );
      }

      if (
        /socket|connect|timeout|reset|econn|enotfound|eai_again/i.test(
          rawError.message,
        )
      ) {
        return new SourceHttpClientError(
          rawError.message,
          DEFAULT_NETWORK_ERROR_CODE,
          true,
          { cause: rawError },
        );
      }
    }

    return new SourceHttpClientError(
      'Request failed',
      'SOURCE_REQUEST_FAILED',
      false,
      { cause: rawError },
    );
  }

  private async sleep(delayMs: number): Promise<void> {
    const sleeper =
      this.#sleeper ??
      (async (value: number) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, value);
        });
      });

    await sleeper(delayMs);
  }

  private jitterValue(): number {
    return Math.max(
      0,
      Math.floor((this.#jitter ?? (() => Math.random() * 25))()),
    );
  }
}

function getHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function normalizeMimeType(value: string | undefined): string {
  const [mimeType = 'application/octet-stream'] = (
    value ?? 'application/octet-stream'
  ).split(';', 1);

  return mimeType.trim().toLowerCase();
}
