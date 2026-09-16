/**
 * document_chunks.embedding 백필 CLI 진입점.
 *
 * 배경:
 *   0016 마이그레이션으로 추가된 embedding 컬럼은 null로 시작한다.
 *   embedding이 null인 chunk는 벡터 검색 후보에서 제외되므로, 백필 전에는
 *   채팅이 기존 LLM 기반 선별로 폴백해 동작한다 (서비스 중단 없음).
 *
 * 운영 실행 절차:
 *   1. 0016 migration 적용            (bun run db:migrate 또는 앱 기동 시 자동)
 *   2. 백필 실행                       (bun run db:backfill:embeddings)
 *   3. 이후 업로드되는 문서는 worker가 ingest 시점에 자동 임베딩
 *
 * 멱등성:
 *   기본 실행은 embedding IS NULL 인 chunk만 처리하므로 여러 번 실행해도 안전하다.
 *   --all 플래그를 주면 모든 chunk를 다시 임베딩한다 (EMBEDDING_MODEL 변경 시 사용).
 *
 * 실행:
 *   DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME (필요 시 DB_SSL=true)과
 *   LETSUR_AI_GATEWAY_BASE_URL/API_KEY (또는 EMBEDDING_BASE_URL/API_KEY) 설정 후
 *   `bun run db:backfill:embeddings` (전체 재임베딩: `bun run db:backfill:embeddings --all`)
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import { buildDatabaseSslOptions } from '../db/ssl-options';
import { documents, documentChunks } from '../db/schema';
import { buildChunkEmbeddingInput } from '../embedding/chunk-embedding-input';
import { DEFAULT_EMBEDDING_MODEL } from '../embedding/embedding.service';
import { assertSecureEndpoint } from '../embedding/embedding-endpoint';
import { parseEmbeddingResponse } from '../embedding/embedding-response';

const BATCH_SIZE = 64;

/** EmbeddingService와 동일한 요청 제한 시간. 응답 없는 서버에 무기한 매달리지 않기 위함. */
const EMBEDDING_TIMEOUT_MS = 15_000;

function requireEnv(name: string, fallbackName?: string): string {
  const value =
    process.env[name] || (fallbackName ? process.env[fallbackName] : undefined);
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}${fallbackName ? ` (or ${fallbackName})` : ''}`,
    );
  }
  return value;
}

async function embedTexts(
  baseUrl: string,
  apiKey: string,
  model: string,
  texts: string[],
): Promise<number[][]> {
  // fetch에는 기본 제한 시간이 없어, 서버가 연결만 붙잡고 응답하지 않으면
  // 백필이 무기한 멈춘다. AbortController로 명시적으로 끊는다.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
      // 리디렉션을 따라가지 않습니다. HTTPS 엔드포인트가 307/308로 HTTP에 넘기면
      // Bearer 토큰과 청크 본문이 평문으로 재전송됩니다.
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `Embedding API timed out after ${EMBEDDING_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Embedding API failed (status ${response.status}): ${body.slice(0, 500)}`,
    );
  }

  const parsed = (await response.json()) as {
    data?: Array<{ index: number; embedding: number[] }>;
  };
  return parseEmbeddingResponse(parsed.data, texts.length);
}

async function main(): Promise<void> {
  const reembedAll = process.argv.includes('--all');

  // 앱(EmbeddingService)과 동일하게 HTTPS를 요구합니다(localhost 예외).
  const embeddingBaseUrl = assertSecureEndpoint(
    requireEnv('EMBEDDING_BASE_URL', 'LETSUR_AI_GATEWAY_BASE_URL'),
    'Embedding base URL',
  );
  const embeddingApiKey = requireEnv(
    'EMBEDDING_API_KEY',
    'LETSUR_AI_GATEWAY_API_KEY',
  );
  const embeddingModel = process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;

  const client = postgres({
    host: requireEnv('DB_HOST'),
    port: Number(process.env.DB_PORT) || 5432,
    database: requireEnv('DB_NAME'),
    username: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    max: 1,
    ssl: buildDatabaseSslOptions(process.env.DB_SSL === 'true'),
  });
  const db = drizzle(client, { schema });

  try {
    const whereCondition = reembedAll
      ? undefined
      : isNull(documentChunks.embedding);

    const baseQuery = db
      .select({
        id: documentChunks.id,
        path: documentChunks.path,
        description: documentChunks.description,
        content: documentChunks.content,
        documentTitle: documents.title,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id));
    const rows = whereCondition
      ? await baseQuery.where(whereCondition)
      : await baseQuery;

    console.log(
      `Backfilling embeddings: ${rows.length} chunk(s) (mode=${reembedAll ? 'all' : 'missing-only'}, model=${embeddingModel})`,
    );

    let processed = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const inputs = batch.map((row) =>
        buildChunkEmbeddingInput({
          documentTitle: row.documentTitle,
          path: row.path,
          description: row.description,
          content: row.content,
        }),
      );

      const embeddings = await embedTexts(
        embeddingBaseUrl,
        embeddingApiKey,
        embeddingModel,
        inputs,
      );

      await db.transaction(async (tx) => {
        for (let j = 0; j < batch.length; j += 1) {
          await tx
            .update(documentChunks)
            .set({ embedding: embeddings[j] })
            .where(eq(documentChunks.id, batch[j].id));
        }
      });

      processed += batch.length;
      console.log(`  ${processed}/${rows.length} chunk(s) embedded`);
    }

    console.log('Backfill complete');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    'Backfill failed:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
