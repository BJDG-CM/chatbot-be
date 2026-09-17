import { describe, expect, it } from '@jest/globals';
import {
  assertSecureEndpoint,
  isLocalHostname,
  resolveEmbeddingCredentials,
} from './embedding-endpoint';

describe('isLocalHostname', () => {
  it('recognises the usual loopback spellings', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1']) {
      expect(isLocalHostname(host)).toBe(true);
    }
  });

  it('does not treat a remote host as local', () => {
    expect(isLocalHostname('gw.letsur.ai')).toBe(false);
    // 앞에 localhost가 붙은 도메인에 속지 않아야 합니다.
    expect(isLocalHostname('localhost.evil.com')).toBe(false);
  });
});

describe('assertSecureEndpoint', () => {
  it('accepts HTTPS and trims trailing slashes', () => {
    expect(assertSecureEndpoint('https://gw.letsur.ai/v1/', 'x')).toBe(
      'https://gw.letsur.ai/v1',
    );
  });

  it('rejects plain HTTP for a remote host', () => {
    // Bearer 토큰이 평문으로 나가는 것을 막습니다 (CWE-319).
    expect(() => assertSecureEndpoint('http://gw.letsur.ai/v1', 'x')).toThrow(
      /must use HTTPS/,
    );
  });

  it('allows plain HTTP for localhost during development', () => {
    expect(assertSecureEndpoint('http://localhost:8080', 'x')).toBe(
      'http://localhost:8080',
    );
    expect(assertSecureEndpoint('http://127.0.0.1:8080', 'x')).toBe(
      'http://127.0.0.1:8080',
    );
  });

  it('rejects an empty or malformed URL', () => {
    expect(() => assertSecureEndpoint('   ', 'x')).toThrow(/empty/);
    expect(() => assertSecureEndpoint('not a url', 'x')).toThrow(
      /not a valid URL/,
    );
  });
});

describe('resolveEmbeddingCredentials', () => {
  const read = (env: Record<string, string>) => (key: string) => env[key];

  it('prefers Letsur when its URL and key are both present', () => {
    expect(
      resolveEmbeddingCredentials(
        read({
          LETSUR_AI_GATEWAY_BASE_URL: 'https://gw.letsur.ai/v1',
          LETSUR_AI_GATEWAY_API_KEY: 'letsur-key',
          OPEN_ROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
          OPEN_ROUTER_API_KEY: 'or-key',
        }),
      ),
    ).toEqual({
      provider: 'letsur',
      baseUrl: 'https://gw.letsur.ai/v1',
      apiKey: 'letsur-key',
    });
  });

  it('falls back to OpenRouter when Letsur is not configured', () => {
    expect(
      resolveEmbeddingCredentials(
        read({
          OPEN_ROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
          OPEN_ROUTER_API_KEY: 'or-key',
        }),
      ),
    ).toEqual({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'or-key',
    });
  });

  it('never pairs one provider URL with another provider key', () => {
    // Letsur URL 만 있고 키가 없으면, OpenRouter 키를 Letsur 로 보내면 안 된다.
    const resolved = resolveEmbeddingCredentials(
      read({
        LETSUR_AI_GATEWAY_BASE_URL: 'https://gw.letsur.ai/v1',
        OPEN_ROUTER_API_KEY: 'or-key',
      }),
    );

    expect(resolved).toBeNull();
  });

  it('ignores a provider whose URL is missing even if its key is set', () => {
    const resolved = resolveEmbeddingCredentials(
      read({
        LETSUR_AI_GATEWAY_API_KEY: 'letsur-key',
        OPEN_ROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      }),
    );

    expect(resolved).toBeNull();
  });

  it('returns null when nothing is configured', () => {
    expect(resolveEmbeddingCredentials(read({}))).toBeNull();
  });
});
