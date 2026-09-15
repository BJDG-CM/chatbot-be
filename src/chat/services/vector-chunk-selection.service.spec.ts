import { describe, expect, it, jest } from '@jest/globals';
import { VectorChunkSelectionService } from './vector-chunk-selection.service';
import type { DenseHit } from '../../retrieval/rank-fusion';

type ChunkSpec = {
  path: string;
  resourceName: string;
  documentId?: string;
  title?: string;
  summary?: string | null;
  description?: string;
  sortOrder?: number;
};

function meta(spec: ChunkSpec) {
  return {
    path: spec.path,
    resourceName: spec.resourceName,
    documentId: spec.documentId ?? spec.resourceName,
    title: spec.title ?? spec.resourceName,
    summary: spec.summary ?? null,
    description: spec.description ?? '',
    sortOrder: spec.sortOrder ?? 0,
  };
}

const dense = (spec: ChunkSpec, distance: number): DenseHit => ({
  ...meta(spec),
  distance,
});

function createService(options: {
  embeddingEnabled?: boolean;
  embedText?: () => Promise<number[]>;
  denseHits?: DenseHit[];
  denseError?: Error;
  config?: Record<string, string>;
}) {
  const embeddingService = {
    isEnabled: jest.fn(() => options.embeddingEnabled ?? true),
    embedText: jest.fn<() => Promise<number[]>>(
      options.embedText ?? (() => Promise.resolve([0.1, 0.2])),
    ),
  };
  const retrievalService = {
    searchChunksByEmbedding: jest.fn<
      (embedding: number[], limit: number) => Promise<DenseHit[]>
    >(() =>
      options.denseError
        ? Promise.reject(options.denseError)
        : Promise.resolve(options.denseHits ?? []),
    ),
  };
  const configService = {
    get: jest.fn(
      (key: string, defaultValue?: string) =>
        options.config?.[key] ?? defaultValue,
    ),
  };

  return {
    service: new VectorChunkSelectionService(
      embeddingService as never,
      retrievalService as never,
      configService as never,
    ),
    embeddingService,
    retrievalService,
  };
}

describe('VectorChunkSelectionService', () => {
  describe('fallback behaviour', () => {
    it('returns null when the embedding API is disabled', async () => {
      const { service, retrievalService } = createService({
        embeddingEnabled: false,
      });

      await expect(
        service.selectRelevantChunkPaths('질문'),
      ).resolves.toBeNull();
      expect(retrievalService.searchChunksByEmbedding).not.toHaveBeenCalled();
    });

    it('returns null when the kill-switch env disables vector retrieval', async () => {
      const { service, embeddingService } = createService({
        config: { EMBEDDING_RETRIEVAL_ENABLED: 'false' },
      });

      await expect(
        service.selectRelevantChunkPaths('질문'),
      ).resolves.toBeNull();
      expect(embeddingService.embedText).not.toHaveBeenCalled();
    });

    // Case 7: embedding failure keeps the existing LLM fallback.
    it('returns null when the question embedding fails', async () => {
      const { service, retrievalService } = createService({
        embedText: () => Promise.reject(new Error('boom')),
      });

      await expect(
        service.selectRelevantChunkPaths('질문'),
      ).resolves.toBeNull();
      expect(retrievalService.searchChunksByEmbedding).not.toHaveBeenCalled();
    });

    it('returns null when vector search itself fails', async () => {
      const { service } = createService({ denseError: new Error('db down') });

      await expect(
        service.selectRelevantChunkPaths('질문'),
      ).resolves.toBeNull();
    });

    it('returns null when no embedded chunks exist (pre-backfill)', async () => {
      const { service } = createService({ denseHits: [] });

      await expect(
        service.selectRelevantChunkPaths('질문'),
      ).resolves.toBeNull();
    });
  });

  describe('candidate generation', () => {
    it('over-retrieves a wide candidate pool rather than only the final Top 5', async () => {
      const { service, retrievalService } = createService({
        denseHits: [dense({ path: 'A/1', resourceName: 'A' }, 0.3)],
      });

      await service.selectRelevantChunkPaths('졸업요건 알려줘', 5);

      expect(retrievalService.searchChunksByEmbedding).toHaveBeenCalledWith(
        expect.anything(),
        20,
      );
    });
  });

  // Case 1: a plain semantic question still resolves through dense retrieval.
  it('selects the semantically nearest chunk for a semantic query', async () => {
    const { service } = createService({
      denseHits: [
        dense(
          { path: '졸업요건안내/이수학점', resourceName: '졸업요건안내' },
          0.31,
        ),
        dense({ path: '수강신청안내/절차', resourceName: '수강신청안내' }, 0.7),
      ],
    });

    const selection = await service.selectRelevantChunkPaths(
      '졸업하려면 학점을 얼마나 들어야 해?',
    );

    expect(selection?.detailPaths[0]).toBe('졸업요건안내/이수학점');
    expect(selection?.rootPaths).toContain('졸업요건안내');
  });

  // Case 2: an exact course code beats a closer but unrelated chunk.
  it('ranks the chunk carrying the course code above a nearer generic chunk', async () => {
    const generic = {
      path: '전공교과목이수안내/선수과목',
      resourceName: '전공교과목이수안내',
      title: '(학사) 전공과목 교과목 이수 안내',
    };
    const exact = {
      path: 'EC2205 강의계획서/선수과목',
      resourceName: 'EC2205 강의계획서',
      title: 'EC2205 전자회로 강의계획서',
    };

    const { service } = createService({
      denseHits: [dense(generic, 0.4), dense(exact, 0.52)],
    });

    const selection =
      await service.selectRelevantChunkPaths('EC2205 선수과목 알려줘');

    expect(selection?.detailPaths[0]).toBe('EC2205 강의계획서/선수과목');
  });

  // Case 3: the year in the query separates 2026 material from 2025 material.
  it('prefers the year-specific document when the query names the year', async () => {
    const y2025 = {
      path: '2025 계절학기 안내/일정',
      resourceName: '2025 계절학기 안내',
      title: '2025학년도 하계 계절학기 안내',
    };
    const y2026 = {
      path: '2026 계절학기 안내/일정',
      resourceName: '2026 계절학기 안내',
      title: '2026학년도 하계 계절학기 안내',
    };

    const { service } = createService({
      // 벡터만 보면 2025 쪽이 더 가깝게 나오는 상황
      denseHits: [dense(y2025, 0.42), dense(y2026, 0.46)],
    });

    const selection =
      await service.selectRelevantChunkPaths('2026 하계 계절학기 일정');

    expect(selection?.detailPaths[0]).toBe('2026 계절학기 안내/일정');
  });

  // Case 4: a strong semantic hit survives even when the wording never overlaps.
  it('keeps a strong vector hit whose wording the query never mentions', async () => {
    const semantic = { path: '학생지원/상담', resourceName: '학생지원' };
    const far = {
      path: '행정안내/민원',
      resourceName: '행정안내',
      title: '행정 민원 안내',
    };

    const { service } = createService({
      denseHits: [dense(semantic, 0.33), dense(far, 0.82)],
    });

    const selection = await service.selectRelevantChunkPaths(
      '힘들 때 누구랑 이야기할 수 있어?',
    );

    expect(selection?.detailPaths).toContain('학생지원/상담');
    // 거리 상한 밖이고 exact 근거도 없는 후보는 통과하지 못합니다.
    expect(selection?.detailPaths).not.toContain('행정안내/민원');
  });

  // Case 5: one document cannot own every slot.
  it('does not let a single document fill the whole selection', async () => {
    const { service } = createService({
      denseHits: [
        dense({ path: '학사편람/1', resourceName: '학사편람' }, 0.3),
        dense({ path: '학사편람/2', resourceName: '학사편람' }, 0.31),
        dense({ path: '학사편람/3', resourceName: '학사편람' }, 0.32),
        dense({ path: '학사편람/4', resourceName: '학사편람' }, 0.33),
        dense({ path: '장학안내/1', resourceName: '장학안내' }, 0.36),
        dense({ path: '수강안내/1', resourceName: '수강안내' }, 0.38),
      ],
    });

    const selection = await service.selectRelevantChunkPaths('학사 안내', 5);
    const perDocument = selection!.detailPaths.filter((path) =>
      path.startsWith('학사편람/'),
    );

    expect(perDocument).toHaveLength(2);
    expect(selection?.detailPaths).toContain('장학안내/1');
    expect(selection?.detailPaths).toContain('수강안내/1');
  });

  // Case 6: an unrelated question gets nothing rather than arbitrary Top-K noise.
  it('returns an empty selection for an unrelated query', async () => {
    const { service } = createService({
      denseHits: [
        dense({ path: '학사편람/졸업', resourceName: '학사편람' }, 0.88),
        dense({ path: '장학안내/신청', resourceName: '장학안내' }, 0.93),
      ],
    });

    await expect(
      service.selectRelevantChunkPaths('오늘 광주 날씨 어때?'),
    ).resolves.toEqual({ rootPaths: [], detailPaths: [] });
  });

  describe('root chunk handling', () => {
    it('adds the root overview chunk for every selected detail chunk', async () => {
      const { service } = createService({
        denseHits: [
          dense({ path: '학사편람/졸업', resourceName: '학사편람' }, 0.3),
          dense({ path: '장학안내/신청', resourceName: '장학안내' }, 0.4),
        ],
      });

      await expect(
        service.selectRelevantChunkPaths('졸업요건과 장학금', 5),
      ).resolves.toEqual({
        rootPaths: ['학사편람', '장학안내'],
        detailPaths: ['학사편람/졸업', '장학안내/신청'],
      });
    });

    it('does not spend the detail quota on directly retrieved root chunks', async () => {
      const { service } = createService({
        denseHits: [
          dense({ path: '학사편람', resourceName: '학사편람' }, 0.3),
          dense({ path: '장학안내/1', resourceName: '장학안내' }, 0.34),
          dense({ path: '수강안내/1', resourceName: '수강안내' }, 0.35),
        ],
      });

      const selection = await service.selectRelevantChunkPaths('학사 안내', 2);

      expect(selection?.detailPaths).toEqual(['장학안내/1', '수강안내/1']);
      expect(selection?.rootPaths).toContain('학사편람');
    });
  });

  it('honours a custom EMBEDDING_MAX_DISTANCE', async () => {
    const { service } = createService({
      config: {
        EMBEDDING_MAX_DISTANCE: '0.4',
        RETRIEVAL_STRONG_DISTANCE: '0.3',
      },
      denseHits: [
        dense({ path: '학사편람/졸업', resourceName: '학사편람' }, 0.28),
        dense({ path: '장학안내/신청', resourceName: '장학안내' }, 0.6),
      ],
    });

    await expect(
      service.selectRelevantChunkPaths('졸업요건 알려줘'),
    ).resolves.toEqual({
      rootPaths: ['학사편람'],
      detailPaths: ['학사편람/졸업'],
    });
  });
});
