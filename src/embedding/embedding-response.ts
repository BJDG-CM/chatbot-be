import { CHUNK_EMBEDDING_DIMENSIONS } from '../db/schema';

/** /embeddings 응답의 한 항목. */
export type EmbeddingResponseItem = {
  index: number;
  embedding: number[];
};

/**
 * /embeddings 응답을 입력 순서에 맞춘 벡터 배열로 변환합니다.
 *
 * 호출부는 결과를 배열 위치로 소비합니다(`embeddings[i]`를 `texts[i]`의 벡터로 사용).
 * 그래서 응답의 `index`가 0..n-1의 순열이 아니면 벡터가 엉뚱한 chunk에 저장되는데,
 * 잘못된 임베딩은 예외 없이 그냥 "검색 품질이 이상한" 상태로만 드러나 추적이 어렵습니다.
 * 정렬 순서에 기대지 않고 `index` 자리에 직접 배치하며, 그 전에 순열인지 검증합니다.
 *
 * 차원도 여기서 확인합니다. EMBEDDING_MODEL은 환경변수로 바꿀 수 있지만
 * document_chunks.embedding은 vector(3072) 고정이라, 검증이 없으면 저장 시점에야
 * DB 오류가 납니다.
 *
 * HttpService(앱)와 fetch(백필 스크립트)가 각각 응답을 받지만 이후 처리는 같으므로
 * 이 함수로 모읍니다.
 */
export function parseEmbeddingResponse(
  data: unknown,
  expectedCount: number,
): number[][] {
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error(
      `Embedding API returned ${Array.isArray(data) ? data.length : 0} vectors for ${expectedCount} inputs`,
    );
  }

  const ordered = new Array<number[] | undefined>(expectedCount);
  for (const item of data as EmbeddingResponseItem[]) {
    const index = item?.index;
    if (!Number.isInteger(index) || index < 0 || index >= expectedCount) {
      throw new Error(
        `Embedding API returned an out-of-range index ${String(index)} for ${expectedCount} inputs`,
      );
    }
    if (ordered[index] !== undefined) {
      throw new Error(`Embedding API returned a duplicate index ${index}`);
    }
    ordered[index] = assertChunkEmbedding(item.embedding);
  }

  // 개수·범위·유일성을 모두 통과하면 빈 칸이 남을 수 없지만, 타입을 좁히기 위해 확인합니다.
  return ordered.map((embedding, index) => {
    if (embedding === undefined) {
      throw new Error(`Embedding API returned no vector for index ${index}`);
    }
    return embedding;
  });
}

/** 응답 벡터가 document_chunks.embedding의 차원과 맞는지 확인합니다. */
export function assertChunkEmbedding(embedding: number[]): number[] {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Embedding API returned an empty vector');
  }
  if (embedding.length !== CHUNK_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding API returned a ${embedding.length}-dimension vector; ` +
        `expected ${CHUNK_EMBEDDING_DIMENSIONS}. Check EMBEDDING_MODEL.`,
    );
  }
  // pgvector는 NaN/Infinity를 거부하고, 거리 계산은 join(',')으로 리터럴을 만듭니다.
  // 문자열이나 null이 섞이면 깨진 리터럴이 그대로 DB로 갑니다.
  const invalid = embedding.findIndex(
    (value) => typeof value !== 'number' || !Number.isFinite(value),
  );
  if (invalid !== -1) {
    throw new Error(
      `Embedding API returned a non-finite value at index ${invalid}`,
    );
  }
  return embedding;
}
