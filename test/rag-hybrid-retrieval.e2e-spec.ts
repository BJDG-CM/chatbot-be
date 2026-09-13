import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import {
  documentChunks,
  documents,
  organizations,
  type Database,
} from '../src/db';
import * as schema from '../src/db/schema';
import { RetrievalRepository } from '../src/retrieval/retrieval.repository';
import { extractQuerySignals } from '../src/retrieval/query-signals';
import {
  applyAdaptiveConfidenceFilter,
  fuseRankings,
  type LexicalHit,
} from '../src/retrieval/rank-fusion';

/**
 * lexical 검색은 생성된 SQL만으로는 검증할 수 없어(ILIKE 실행·pg_trgm·문서 필터)
 * 실제 PostgreSQL에 붙여서 확인한다. 임베딩 API는 쓰지 않으므로 결과가 결정적이다.
 *
 * 실행:
 *   RAG_RETRIEVAL_TEST_DB=true DB_NAME=..._test \
 *     jest --config ./test/jest-e2e.json test/rag-hybrid-retrieval.e2e-spec.ts
 */
const describeDatabase =
  process.env.RAG_RETRIEVAL_TEST_DB === 'true' ? describe : describe.skip;

describeDatabase('Hybrid retrieval lexical search (e2e)', () => {
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

  async function lexicalSearch(question: string): Promise<LexicalHit[]> {
    const signals = extractQuerySignals(question);
    const hits = await repo.searchChunksByLexical(
      signals.terms,
      signals.exactSignals.map((signal) => signal.value),
      50,
    );
    return mine(hits);
  }

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
      },
      {
        documentId: courseId,
        path: `${testPrefix} EC2205 전자회로 강의계획서/선수과목`,
        description: '선수과목 요건',
        // EC2201은 본문에만 등장한다 — content 스캔 검증용
        content: 'EC2205를 수강하려면 EC2201 회로이론을 먼저 이수해야 한다.',
        sortOrder: 1,
      },
      {
        documentId: genericId,
        path: `${testPrefix} 전공과목 교과목 이수 안내`,
        description: '문서 개요',
        content: '전공과목 이수 안내 개요',
        sortOrder: 0,
      },
      {
        documentId: genericId,
        path: `${testPrefix} 전공과목 교과목 이수 안내/선수과목`,
        description: '선수과목 일반 규정',
        content: '전공 교과목은 선수과목을 먼저 이수해야 수강할 수 있다.',
        sortOrder: 1,
      },
      {
        documentId: y2026Id,
        path: `${testPrefix} 2026학년도 하계 계절학기 운영 안내/일정`,
        description: '운영 일정',
        content: '2026년 6월 23일 개강, 7월 25일 종강',
        sortOrder: 1,
      },
      {
        documentId: y2025Id,
        path: `${testPrefix} 2025학년도 하계 계절학기 운영 안내/일정`,
        description: '운영 일정',
        content: '2025년 6월 24일 개강, 7월 26일 종강',
        sortOrder: 1,
      },
      {
        documentId: expiredId,
        path: `${testPrefix} EC2205 만료 사본`,
        description: '문서 개요',
        content: 'EC2205 선수과목 만료본',
        sortOrder: 0,
      },
      {
        documentId: inactiveId,
        path: `${testPrefix} EC2205 비활성 사본`,
        description: '문서 개요',
        content: 'EC2205 선수과목 비활성본',
        sortOrder: 0,
      },
      {
        documentId: processingId,
        path: `${testPrefix} EC2205 처리중 사본`,
        description: '문서 개요',
        content: 'EC2205 선수과목 처리중본',
        sortOrder: 0,
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

  it('ranks the chunk carrying the course code first', async () => {
    const hits = await lexicalSearch('EC2205 선수과목 알려줘');

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].documentId).toBe(documentIds.course);
    // 코드가 없는 일반 문서보다 확실히 높은 점수를 받아야 한다
    const generic = hits.find((hit) => hit.documentId === documentIds.generic);
    expect(hits[0].score).toBeGreaterThan(generic?.score ?? 0);
  });

  it('separates the year-specific document from the neighbouring year', async () => {
    const hits = await lexicalSearch('2026 하계 계절학기 일정');

    const rank2026 = hits.findIndex((h) => h.documentId === documentIds.y2026);
    const rank2025 = hits.findIndex((h) => h.documentId === documentIds.y2025);
    expect(rank2026).toBeGreaterThanOrEqual(0);
    expect(rank2026).toBeLessThan(rank2025 === -1 ? Infinity : rank2025);
  });

  it('finds an exact signal that appears only in the chunk body', async () => {
    const hits = await lexicalSearch('EC2201 회로이론');

    expect(hits.map((h) => h.path)).toContain(
      `${testPrefix} EC2205 전자회로 강의계획서/선수과목`,
    );
  });

  it('excludes expired, inactive and unprocessed documents', async () => {
    const hits = await lexicalSearch('EC2205 선수과목');

    const excluded = [
      documentIds.expired,
      documentIds.inactive,
      documentIds.processing,
    ];
    expect(hits.filter((h) => excluded.includes(h.documentId))).toHaveLength(0);
  });

  it('returns nothing for an unrelated query', async () => {
    const hits = await lexicalSearch('오늘 광주 날씨 어때');

    expect(hits).toHaveLength(0);
  });

  it('escapes LIKE wildcards so a query cannot match everything', async () => {
    const hits = await lexicalSearch('"100%_할인"');

    expect(hits).toHaveLength(0);
  });

  it('counts distinct matched terms rather than one word across fields', async () => {
    // "안내"는 계절학기 문서의 제목·경로·요약에 모두 등장하지만 검색어는 하나뿐이다.
    const hits = await lexicalSearch('선수과목 이수 안내');

    const seasonal = hits.find((h) => h.documentId === documentIds.y2026);
    const generic = hits.find((h) => h.documentId === documentIds.generic);

    expect(seasonal?.matchedTerms).toBe(1);
    expect(generic?.matchedTerms).toBeGreaterThanOrEqual(2);
  });

  it('stops a single common word from rescuing a middling vector hit', async () => {
    const signals = extractQuerySignals('선수과목 이수 안내');
    const lexicalHits = await lexicalSearch('선수과목 이수 안내');

    // 계절학기 문서를 "거리는 애매하지만 lexical에 잡힌" 후보로 놓는다.
    // 최상위 후보를 따로 두어야 near-best-vector 규칙에 걸리지 않는다.
    const seasonal = lexicalHits.find(
      (h) => h.documentId === documentIds.y2026,
    )!;
    const nearest = lexicalHits.find(
      (h) => h.documentId === documentIds.generic,
    )!;
    const fused = fuseRankings({
      denseHits: [
        { ...nearest, distance: 0.42 },
        { ...seasonal, distance: 0.68 },
      ],
      lexicalHits,
      exactSignals: signals.exactSignals,
    });
    const { decisions } = applyAdaptiveConfidenceFilter(fused, {
      queryTermCount: signals.terms.length,
    });

    const seasonalDecision = decisions.find(
      (d) => d.candidate.documentId === documentIds.y2026,
    );
    expect(seasonalDecision?.keep).toBe(false);
    expect(seasonalDecision?.reason).toBe('weak-support');
  });

  it('keeps a lexical-only candidate that carries a title-strength exact match', async () => {
    // dense 후보가 전혀 없어도 exact 근거가 강하면 살아남아야 한다.
    const signals = extractQuerySignals('EC2205 선수과목');
    const lexicalHits = await lexicalSearch('EC2205 선수과목');

    const fused = fuseRankings({
      denseHits: [],
      lexicalHits,
      exactSignals: signals.exactSignals,
    });
    const { kept, decisions } = applyAdaptiveConfidenceFilter(fused);

    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0].documentId).toBe(documentIds.course);
    expect(decisions[0].reason).toBe('strong-exact');
  });
});
