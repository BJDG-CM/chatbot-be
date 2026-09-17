import { describe, expect, it, jest } from '@jest/globals';
import { of } from 'rxjs';
import { EmbeddingService } from './embedding.service';
import { CHUNK_EMBEDDING_DIMENSIONS } from '../db/schema';

type PostArgs = [string, unknown, Record<string, unknown>];

/** 컬럼 차원과 같은 길이의 더미 벡터. 차원 검증을 통과시키기 위함입니다. */
const validVector = (length = CHUNK_EMBEDDING_DIMENSIONS): number[] =>
  new Array<number>(length).fill(0.1);

function createService(
  config: Record<string, string>,
  embedding: number[] = validVector(),
) {
  const post = jest.fn((..._args: PostArgs) =>
    of({ data: { data: [{ index: 0, embedding }] } }),
  );
  const httpService = { post } as never;
  const configService = {
    get: <T>(key: string, defaultValue?: T) =>
      (config[key] as unknown as T) ?? defaultValue,
  } as never;

  return { service: new EmbeddingService(httpService, configService), post };
}

describe('EmbeddingService', () => {
  const https = { LETSUR_AI_GATEWAY_BASE_URL: 'https://gw.example.com/v1' };

  it('is enabled for an HTTPS endpoint with a key', () => {
    const { service } = createService({
      ...https,
      LETSUR_AI_GATEWAY_API_KEY: 'k',
    });
    expect(service.isEnabled()).toBe(true);
  });

  it('disables itself for a plain HTTP endpoint', () => {
    // 검증 실패 시 예외로 앱을 죽이지 않고, 호출부가 LLM 선별로 폴백하게 둡니다.
    const { service } = createService({
      LETSUR_AI_GATEWAY_BASE_URL: 'http://gw.example.com/v1',
      LETSUR_AI_GATEWAY_API_KEY: 'k',
    });
    expect(service.isEnabled()).toBe(false);
  });

  it('refuses to follow redirects when calling the embedding API', async () => {
    // HTTPS 엔드포인트가 307/308로 HTTP에 넘기면 Bearer 토큰이 평문으로 재전송됩니다.
    const { service, post } = createService({
      ...https,
      LETSUR_AI_GATEWAY_API_KEY: 'k',
    });

    await service.embedTexts(['hello']);

    expect(post).toHaveBeenCalledTimes(1);
    const options = post.mock.calls[0][2];
    expect(options.maxRedirects).toBe(0);
  });

  it('sends the bearer token only to the configured HTTPS URL', async () => {
    const { service, post } = createService({
      ...https,
      LETSUR_AI_GATEWAY_API_KEY: 'secret',
    });

    await service.embedTexts(['hello']);

    const [url, , options] = post.mock.calls[0];
    expect(url).toBe('https://gw.example.com/v1/embeddings');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret',
    );
  });

  it('rejects a vector whose dimension does not match the column', async () => {
    // EMBEDDING_MODEL 을 다른 차원의 모델로 바꾸면 저장 시점에야 DB 오류가 납니다.
    // 원인에서 먼 곳에서 터지지 않도록 API 응답 경계에서 막습니다.
    const { service } = createService(
      { ...https, LETSUR_AI_GATEWAY_API_KEY: 'k' },
      validVector(1536),
    );

    await expect(service.embedTexts(['hello'])).rejects.toThrow(
      `Embedding API returned a 1536-dimension vector; expected ${CHUNK_EMBEDDING_DIMENSIONS}`,
    );
  });

  it('rejects an empty vector', async () => {
    const { service } = createService(
      { ...https, LETSUR_AI_GATEWAY_API_KEY: 'k' },
      [],
    );

    await expect(service.embedTexts(['hello'])).rejects.toThrow(
      'Embedding API returned an empty vector',
    );
  });

  it('returns a vector that matches the column dimension', async () => {
    const { service } = createService({
      ...https,
      LETSUR_AI_GATEWAY_API_KEY: 'k',
    });

    const [vector] = await service.embedTexts(['hello']);

    expect(vector).toHaveLength(CHUNK_EMBEDDING_DIMENSIONS);
  });

  it('prefers the Letsur gateway over OpenRouter', async () => {
    // 임베딩 기본 플랫폼은 Letsur 다. OpenRouter 는 Letsur 설정이 없을 때만 쓴다.
    const { service, post } = createService({
      OPEN_ROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPEN_ROUTER_API_KEY: 'or-key',
      LETSUR_AI_GATEWAY_BASE_URL: 'https://gw.letsur.ai/v1',
      LETSUR_AI_GATEWAY_API_KEY: 'letsur-key',
    });

    await service.embedTexts(['hello']);

    const [url, , options] = post.mock.calls[0];
    expect(url).toBe('https://gw.letsur.ai/v1/embeddings');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer letsur-key',
    );
  });

  it('falls back to OpenRouter when Letsur is not configured', async () => {
    const { service, post } = createService({
      OPEN_ROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPEN_ROUTER_API_KEY: 'or-key',
    });

    await service.embedTexts(['hello']);

    expect(post.mock.calls[0][0]).toBe(
      'https://openrouter.ai/api/v1/embeddings',
    );
  });
});
