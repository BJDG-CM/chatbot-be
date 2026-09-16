import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import {
  CHUNK_EMBEDDING_DIMENSIONS,
  documentChunks,
  documents,
  organizations,
  type Database,
} from '../src/db';
import * as schema from '../src/db/schema';
import { RetrievalRepository } from '../src/retrieval/retrieval.repository';
import { halfvecCosineDistance } from '../src/retrieval/retrieval.repository';

/**
 * 벡터 검색은 생성된 SQL만으로는 검증할 수 없어 실제 PostgreSQL에 붙여서 확인한다.
 * 임베딩 API는 쓰지 않고 고정 벡터를 넣으므로 결과가 결정적이다.
 *
 * 특히 halfvec 캐스팅은 조용히 깨지는 종류의 버그다. embedding은 vector(3072)이고
 * pgvector의 HNSW는 vector를 2000차원까지만 인덱싱하므로 인덱스를 halfvec 캐스팅으로
 * 만들었는데(migration 0017), 질의가 같은 식을 쓰지 않으면 인덱스를 타지 않고
 * Seq Scan으로 조용히 떨어진다. 결과는 맞게 나오므로 단위 테스트로는 잡히지 않는다.
 *
 * 실행:
 *   RAG_RETRIEVAL_TEST_DB=true DB_NAME=..._test \
 *     jest --config ./test/jest-e2e.json test/rag-vector-retrieval.e2e-spec.ts
 */
const describeDatabase =
  process.env.RAG_RETRIEVAL_TEST_DB === 'true' ? describe : describe.skip;

describeDatabase('Vector retrieval (e2e)', () => {
  const testPrefix = `rag-e2e-${Date.now()}`;
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repo: RetrievalRepository;
  let organizationId: string;

  /** 픽스처 문서 id — 다른 테스트 데이터와 섞이지 않도록 결과를 여기로 한정한다. */
  const documentIds: Record<string, string> = {};

  /** 검색 결과에서 이 테스트가 만든 문서만 남긴다. */
  const mine = <T extends { documentId: string }>(hits: T[]): T[] =>
    hits.filter((hit) => Object.values(documentIds).includes(hit.documentId));

  /**
   * 결정적인 단위 벡터. seed 로 방향만 살짝 틀어 거리 순서를 통제한다.
   * 임베딩 API를 부르지 않으므로 테스트가 외부에 의존하지 않는다.
   */
  const vec = (seed: number): number[] => {
    const v = new Array<number>(CHUNK_EMBEDDING_DIMENSIONS).fill(0);
    v[0] = 1;
    v[seed % (CHUNK_EMBEDDING_DIMENSIONS - 1)] = seed / 100;
    return v;
  };

  beforeAll(async () => {
    const database = process.env.DB_NAME ?? '';
    if (!database.endsWith('_test')) {
      throw new Error('Hybrid retrieval E2E requires DB_NAME ending in _test');
    }
    client = postgres({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      database,
      username: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      max: 5,
    });
    db = drizzle(client, { schema });
    repo = new RetrievalRepository(db as unknown as Database);

    const [organization] = await db
      .insert(organizations)
      .values({ name: `${testPrefix}-org`, slug: `${testPrefix}-org` })
      .returning();
    organizationId = organization.id;

    const makeDocument = async (
      key: string,
      title: string,
      summary: string,
      overrides: Partial<typeof documents.$inferInsert> = {},
    ) => {
      const [document] = await db
        .insert(documents)
        .values({
          title,
          resourceName: title,
          summary,
          gcsPdfPath: `gs://${testPrefix}/${key}.pdf`,
          status: 'ready',
          isActive: true,
          uploadedByIdpUuid: testPrefix,
          ownerOrganizationId: organizationId,
          ...overrides,
        })
        .returning();
      documentIds[key] = document.id;
      return document.id;
    };

    // 과목코드가 제목에 있는 문서 vs 의미상 가깝지만 코드가 없는 문서
    const courseId = await makeDocument(
      'course',
      `${testPrefix} EC2205 전자회로 강의계획서`,
      'EC2205 과목의 선수과목과 평가 방식 안내',
    );
    const genericId = await makeDocument(
      'generic',
      `${testPrefix} 전공과목 교과목 이수 안내`,
      '전공 교과목의 선수과목 이수 체계 일반 안내',
    );
    // 연도만 다른 두 문서
    const y2026Id = await makeDocument(
      'y2026',
      `${testPrefix} 2026학년도 하계 계절학기 운영 안내`,
      '2026년 하계 계절학기 수강신청 및 일정 안내',
    );
    const y2025Id = await makeDocument(
      'y2025',
      `${testPrefix} 2025학년도 하계 계절학기 운영 안내`,
      '2025년 하계 계절학기 수강신청 및 일정 안내',
    );
    // 검색 대상에서 빠져야 하는 문서들
    const expiredId = await makeDocument(
      'expired',
      `${testPrefix} EC2205 만료 사본`,
      'EC2205 선수과목 만료본',
      { expiresAt: new Date(Date.now() - 86_400_000) },
    );
    const inactiveId = await makeDocument(
      'inactive',
      `${testPrefix} EC2205 비활성 사본`,
      'EC2205 선수과목 비활성본',
      { isActive: false },
    );
    const processingId = await makeDocument(
      'processing',
      `${testPrefix} EC2205 처리중 사본`,
      'EC2205 선수과목 처리중본',
      { status: 'processing' },
    );

    await db.insert(documentChunks).values([
      {
        documentId: courseId,
        path: `${testPrefix} EC2205 전자회로 강의계획서`,
        description: '문서 개요',
        content: 'EC2205 전자회로 강의계획서 개요',
        sortOrder: 0,
        embedding: vec(1),
      },
      {
        documentId: courseId,
        path: `${testPrefix} EC2205 전자회로 강의계획서/선수과목`,
        description: '선수과목 요건',
        // EC2201은 본문에만 등장한다 — content 스캔 검증용
        content: 'EC2205를 수강하려면 EC2201 회로이론을 먼저 이수해야 한다.',
        sortOrder: 1,
        embedding: vec(2),
      },
      {
        documentId: genericId,
        path: `${testPrefix} 전공과목 교과목 이수 안내`,
        description: '문서 개요',
        content: '전공과목 이수 안내 개요',
        sortOrder: 0,
        embedding: vec(1),
      },
      {
        documentId: genericId,
        path: `${testPrefix} 전공과목 교과목 이수 안내/선수과목`,
        description: '선수과목 일반 규정',
        content: '전공 교과목은 선수과목을 먼저 이수해야 수강할 수 있다.',
        sortOrder: 1,
        embedding: vec(2),
      },
      {
        documentId: y2026Id,
        path: `${testPrefix} 2026학년도 하계 계절학기 운영 안내/일정`,
        description: '운영 일정',
        content: '2026년 6월 23일 개강, 7월 25일 종강',
        sortOrder: 1,
        embedding: vec(2),
      },
      {
        documentId: y2025Id,
        path: `${testPrefix} 2025학년도 하계 계절학기 운영 안내/일정`,
        description: '운영 일정',
        content: '2025년 6월 24일 개강, 7월 26일 종강',
        sortOrder: 1,
        embedding: vec(2),
      },
      {
        documentId: expiredId,
        path: `${testPrefix} EC2205 만료 사본`,
        description: '문서 개요',
        content: 'EC2205 선수과목 만료본',
        sortOrder: 0,
        embedding: vec(1),
      },
      {
        documentId: inactiveId,
        path: `${testPrefix} EC2205 비활성 사본`,
        description: '문서 개요',
        content: 'EC2205 선수과목 비활성본',
        sortOrder: 0,
        embedding: vec(1),
      },
      {
        documentId: processingId,
        path: `${testPrefix} EC2205 처리중 사본`,
        description: '문서 개요',
        content: 'EC2205 선수과목 처리중본',
        sortOrder: 0,
        embedding: vec(1),
      },
    ]);
  });

  afterAll(async () => {
    const ids = Object.values(documentIds);
    if (ids.length > 0) {
      await db
        .delete(documentChunks)
        .where(inArray(documentChunks.documentId, ids));
      await db.delete(documents).where(inArray(documents.id, ids));
    }
    if (organizationId) {
      await db
        .delete(organizations)
        .where(eq(organizations.id, organizationId));
    }
    await client?.end();
  });

  it('excludes expired, inactive and still-processing documents', async () => {
    const hits = mine(await repo.searchChunksByEmbedding(vec(1), 50));

    expect(hits.length).toBeGreaterThan(0);
    const excluded = [
      documentIds.expired,
      documentIds.inactive,
      documentIds.processing,
    ];
    expect(hits.filter((h) => excluded.includes(h.documentId))).toHaveLength(0);
  });

  it('orders results by ascending cosine distance', async () => {
    const hits = mine(await repo.searchChunksByEmbedding(vec(1), 50));
    const distances = hits.map((h) => h.distance);

    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('uses the halfvec HNSW index rather than falling back to a sequential scan', async () => {
    // 249행짜리 픽스처에서는 플래너가 Seq Scan 을 더 싸게 보므로, 인덱스를 "쓸 수 있는지"만 본다.
    // SET LOCAL 은 트랜잭션 안에서만 유효하므로 EXPLAIN 과 같은 트랜잭션에서 실행한다.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const distance = halfvecCosineDistance(vec(1));
      const rows = await tx.execute(
        sql`EXPLAIN SELECT ${documentChunks.id} FROM ${documentChunks} ORDER BY ${distance} LIMIT 5`,
      );
      return (rows as unknown as Array<Record<string, string>>)
        .map((row) => Object.values(row).join(' '))
        .join('\n');
    });

    // 인덱스 식과 질의 식이 어긋나면 이 단언이 깨진다 — 결과는 맞지만 인덱스를 못 타는 상태.
    expect(plan).toContain('document_chunks_embedding_hnsw_idx');
  });
});
