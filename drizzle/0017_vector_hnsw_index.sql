-- document_chunks.embedding 벡터 검색 인덱스.
--
-- embedding은 vector(3072)이고 pgvector의 HNSW는 vector 타입을 2000차원까지만
-- 인덱싱하므로, 반정밀도(halfvec, 상한 4000차원)로 캐스팅해 인덱스를 만든다.
-- 이 인덱스를 타려면 질의도 동일한 캐스팅 식을 써야 한다
-- (RetrievalRepository.searchChunksByEmbedding 참고).
--
-- 잠금 시간: 인덱스 생성은 document_chunks를 잠근다. pgvector 0.8.6 실측으로
-- chunk 1,000개 약 0.5초, 5,000개 약 2초 수준이라 현재 규모에서는 무시할 만하다.
-- 수만 건 이상으로 커진 뒤 적용한다면, 마이그레이션에서 이 문을 지우고
-- CREATE INDEX CONCURRENTLY로 따로 생성할 것
-- (drizzle 마이그레이션은 트랜잭션 안에서 실행되어 CONCURRENTLY를 쓸 수 없다).
CREATE INDEX IF NOT EXISTS "document_chunks_embedding_hnsw_idx"
  ON "document_chunks"
  USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);
