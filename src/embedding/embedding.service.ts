import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { AxiosError } from 'axios';
import { assertSecureEndpoint } from './embedding-endpoint';

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-large';

type EmbeddingsApiResponse = {
  data: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
};

/**
 * OpenAI 호환 /embeddings 클라이언트 (Letsur AI Gateway 등)
 * - EMBEDDING_BASE_URL/EMBEDDING_API_KEY 미설정 시 Letsur 게이트웨이 설정을 재사용합니다.
 * - 설정이 전혀 없으면 비활성화되어, 호출부는 LLM 선별로 폴백합니다.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);

  private readonly baseUrl: string | null;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
  ) {
    const baseUrl =
      configService.get<string>('EMBEDDING_BASE_URL') ||
      configService.get<string>('LETSUR_AI_GATEWAY_BASE_URL') ||
      '';
    const apiKey =
      configService.get<string>('EMBEDDING_API_KEY') ||
      configService.get<string>('LETSUR_AI_GATEWAY_API_KEY') ||
      '';

    // Bearer 토큰이 평문으로 나가지 않도록 HTTPS를 요구합니다(localhost는 예외).
    // 잘못 설정된 경우 임베딩을 비활성화해, 호출부가 LLM 선별로 폴백하게 둡니다.
    let validatedBaseUrl: string | null = null;
    if (baseUrl) {
      try {
        validatedBaseUrl = assertSecureEndpoint(baseUrl, 'Embedding base URL');
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    this.baseUrl = validatedBaseUrl;
    this.apiKey = apiKey || null;
    this.model =
      configService.get<string>('EMBEDDING_MODEL') || DEFAULT_EMBEDDING_MODEL;
    this.timeoutMs = 15000;

    if (!this.isEnabled()) {
      this.logger.warn(
        'Embedding API not configured (EMBEDDING_BASE_URL/LETSUR_AI_GATEWAY_BASE_URL missing); vector retrieval disabled',
      );
    }
  }

  isEnabled(): boolean {
    return this.baseUrl != null && this.apiKey != null;
  }

  getModel(): string {
    return this.model;
  }

  /**
   * 입력 순서대로 임베딩 벡터를 반환합니다. 비활성화/실패 시 throw.
   */
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (!this.isEnabled()) {
      throw new Error('Embedding API is not configured');
    }
    if (texts.length === 0) return [];

    try {
      const response = await firstValueFrom(
        this.httpService.post<EmbeddingsApiResponse>(
          `${this.baseUrl}/embeddings`,
          { model: this.model, input: texts },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: this.timeoutMs,
          },
        ),
      );

      const data = response.data?.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(
          `Embedding API returned ${data?.length ?? 0} vectors for ${texts.length} inputs`,
        );
      }

      const ordered = [...data].sort((a, b) => a.index - b.index);
      return ordered.map((d) => {
        if (!Array.isArray(d.embedding) || d.embedding.length === 0) {
          throw new Error('Embedding API returned an empty vector');
        }
        return d.embedding;
      });
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      this.logger.error(
        `Embedding API call failed${status ? ` (status ${status})` : ''}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  async embedText(text: string): Promise<number[]> {
    const [vector] = await this.embedTexts([text]);
    return vector;
  }
}
