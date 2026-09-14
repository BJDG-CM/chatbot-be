import { describe, expect, it, jest } from '@jest/globals';
import { of } from 'rxjs';
import { EmbeddingService } from './embedding.service';

type PostArgs = [string, unknown, Record<string, unknown>];

function createService(config: Record<string, string>) {
  const post = jest.fn((..._args: PostArgs) =>
    of({ data: { data: [{ index: 0, embedding: [0.1, 0.2] }] } }),
  );
  const httpService = { post } as never;
  const configService = {
    get: <T>(key: string, defaultValue?: T) =>
      (config[key] as unknown as T) ?? defaultValue,
  } as never;

  return { service: new EmbeddingService(httpService, configService), post };
}

describe('EmbeddingService', () => {
  const https = { EMBEDDING_BASE_URL: 'https://gw.example.com/v1' };

  it('is enabled for an HTTPS endpoint with a key', () => {
    const { service } = createService({ ...https, EMBEDDING_API_KEY: 'k' });
    expect(service.isEnabled()).toBe(true);
  });

  it('disables itself for a plain HTTP endpoint', () => {
    // 검증 실패 시 예외로 앱을 죽이지 않고, 호출부가 LLM 선별로 폴백하게 둡니다.
    const { service } = createService({
      EMBEDDING_BASE_URL: 'http://gw.example.com/v1',
      EMBEDDING_API_KEY: 'k',
    });
    expect(service.isEnabled()).toBe(false);
  });

  it('refuses to follow redirects when calling the embedding API', async () => {
    // HTTPS 엔드포인트가 307/308로 HTTP에 넘기면 Bearer 토큰이 평문으로 재전송됩니다.
    const { service, post } = createService({
      ...https,
      EMBEDDING_API_KEY: 'k',
    });

    await service.embedTexts(['hello']);

    expect(post).toHaveBeenCalledTimes(1);
    const options = post.mock.calls[0][2];
    expect(options.maxRedirects).toBe(0);
  });

  it('sends the bearer token only to the configured HTTPS URL', async () => {
    const { service, post } = createService({
      ...https,
      EMBEDDING_API_KEY: 'secret',
    });

    await service.embedTexts(['hello']);

    const [url, , options] = post.mock.calls[0];
    expect(url).toBe('https://gw.example.com/v1/embeddings');
    expect((options.headers as Record<string, string>).Authorization).toBe(
      'Bearer secret',
    );
  });
});
