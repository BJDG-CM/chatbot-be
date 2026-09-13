import { describe, expect, it } from '@jest/globals';
import { extractExactSignals } from './query-signals';
import {
  applyAdaptiveConfidenceFilter,
  enforceDocumentDiversity,
  fuseRankings,
  reciprocalRankTerm,
  scoreExactMatches,
  type CandidateMetadata,
  type DenseHit,
  type LexicalHit,
  type RetrievalCandidate,
} from './rank-fusion';
import { EXACT_FIELD_WEIGHTS } from './retrieval.constants';

type ChunkSpec = {
  path: string;
  resourceName: string;
  documentId?: string;
  title?: string;
  summary?: string | null;
  description?: string;
  sortOrder?: number;
};

function meta(spec: ChunkSpec): CandidateMetadata {
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

const lexical = (
  spec: ChunkSpec,
  score: number,
  matchedTerms = 2,
): LexicalHit => ({
  ...meta(spec),
  score,
  matchedTerms,
});

const candidate = (
  spec: ChunkSpec,
  over: Partial<RetrievalCandidate> = {},
): RetrievalCandidate => ({
  ...meta(spec),
  isRoot: spec.path === spec.resourceName,
  exactScore: 0,
  exactMatches: [],
  fusedScore: 0,
  ...over,
});

describe('reciprocalRankTerm', () => {
  it('follows weight / (k + rank)', () => {
    expect(reciprocalRankTerm(1, 1, 60)).toBeCloseTo(1 / 61, 10);
    expect(reciprocalRankTerm(5, 2, 60)).toBeCloseTo(2 / 65, 10);
  });

  it('contributes nothing when the candidate is absent from that ranking', () => {
    expect(reciprocalRankTerm(undefined, 1, 60)).toBe(0);
    expect(reciprocalRankTerm(0, 1, 60)).toBe(0);
  });
});

describe('scoreExactMatches', () => {
  it('weights a title hit and a path hit above a description hit', () => {
    const signals = extractExactSignals('EC2205');
    const titleHit = scoreExactMatches(
      meta({
        path: '과목안내/개요',
        resourceName: '과목안내',
        title: 'EC2205 강의계획서',
      }),
      signals,
    );
    const descriptionHit = scoreExactMatches(
      meta({
        path: '과목안내/개요',
        resourceName: '과목안내',
        description: 'EC2205 선수과목 목록',
      }),
      signals,
    );

    expect(titleHit.score).toBe(EXACT_FIELD_WEIGHTS.title);
    expect(titleHit.matches).toEqual(['EC2205']);
    expect(descriptionHit.score).toBe(EXACT_FIELD_WEIGHTS.description);
    expect(titleHit.score).toBeGreaterThan(descriptionHit.score);
  });

  it('scores zero when there are no signals', () => {
    expect(
      scoreExactMatches(meta({ path: 'a/b', resourceName: 'a' }), []),
    ).toEqual({ score: 0, matches: [] });
  });
});

describe('fuseRankings', () => {
  it('promotes a candidate that appears in both dense and lexical results', () => {
    // dense 1위(어휘 근거 없음) vs dense 5위 + lexical 1위
    const denseOnly = { path: 'A/1', resourceName: 'A' };
    const both = { path: 'B/1', resourceName: 'B' };

    const fused = fuseRankings({
      denseHits: [
        dense(denseOnly, 0.4),
        dense({ path: 'C/1', resourceName: 'C' }, 0.45),
        dense({ path: 'C/2', resourceName: 'C' }, 0.46),
        dense({ path: 'C/3', resourceName: 'C' }, 0.47),
        dense(both, 0.6),
      ],
      lexicalHits: [lexical(both, 12)],
      exactSignals: [],
    });

    expect(fused[0].path).toBe('B/1');
    expect(fused[0].denseRank).toBe(5);
    expect(fused[0].lexicalRank).toBe(1);
    expect(fused[1].path).toBe('A/1');
  });

  it('lets an exact signal outrank a closer but lexically unrelated chunk', () => {
    const signals = extractExactSignals('EC2205 선수과목');
    const unrelated = {
      path: '전공교과목안내/선수과목',
      resourceName: '전공교과목안내',
      title: '전공교과목 이수 안내',
    };
    const exact = {
      path: 'EC2205 강의계획서/선수과목',
      resourceName: 'EC2205 강의계획서',
      title: 'EC2205 강의계획서',
    };

    const fused = fuseRankings({
      denseHits: [dense(unrelated, 0.4), dense(exact, 0.52)],
      lexicalHits: [lexical(exact, 16)],
      exactSignals: signals,
    });

    expect(fused[0].path).toBe('EC2205 강의계획서/선수과목');
    expect(fused[0].exactMatches).toEqual(['EC2205']);
    expect(fused[0].exactRank).toBe(1);
    expect(fused[1].exactRank).toBeUndefined();
  });

  it('keeps a purely semantic hit in the fused list', () => {
    const semantic = { path: 'A/1', resourceName: 'A' };
    const fused = fuseRankings({
      denseHits: [dense(semantic, 0.32)],
      lexicalHits: [lexical({ path: 'B/1', resourceName: 'B' }, 9)],
      exactSignals: [],
    });

    expect(fused.map((c) => c.path)).toContain('A/1');
    expect(fused.find((c) => c.path === 'A/1')?.denseRank).toBe(1);
  });

  it('keeps candidates from different documents apart even on the same path', () => {
    // document_chunks의 유일성 제약은 (documentId, path)이므로 path가 겹칠 수 있다.
    const fused = fuseRankings({
      denseHits: [
        dense({ path: '개요', resourceName: 'A', documentId: 'doc-a' }, 0.3),
        dense({ path: '개요', resourceName: 'B', documentId: 'doc-b' }, 0.4),
      ],
      lexicalHits: [],
      exactSignals: [],
    });

    expect(fused).toHaveLength(2);
    expect(fused.map((c) => c.documentId).sort()).toEqual(['doc-a', 'doc-b']);
    // 뒤 후보의 메타데이터가 앞 후보로 병합되지 않아야 한다.
    expect(fused.find((c) => c.documentId === 'doc-b')?.resourceName).toBe('B');
  });

  it('marks a chunk whose path equals the resource name as a root chunk', () => {
    const fused = fuseRankings({
      denseHits: [dense({ path: 'A', resourceName: 'A' }, 0.3)],
      lexicalHits: [],
      exactSignals: [],
    });
    expect(fused[0].isRoot).toBe(true);
  });

  it('gives tied exact scores the same rank', () => {
    const signals = extractExactSignals('2026');
    const fused = fuseRankings({
      denseHits: [
        dense({ path: 'A/1', resourceName: 'A', title: '2026 안내' }, 0.4),
        dense({ path: 'B/1', resourceName: 'B', title: '2026 일정' }, 0.41),
      ],
      lexicalHits: [],
      exactSignals: signals,
    });
    expect(fused.map((c) => c.exactRank)).toEqual([1, 1]);
  });
});

describe('applyAdaptiveConfidenceFilter', () => {
  it('keeps a strong vector hit with no other evidence', () => {
    const { kept, decisions } = applyAdaptiveConfidenceFilter([
      candidate({ path: 'A/1', resourceName: 'A' }, { denseDistance: 0.35 }),
    ]);
    expect(kept).toHaveLength(1);
    expect(decisions[0].reason).toBe('strong-vector');
  });

  it('keeps a middling vector hit when lexical search agrees', () => {
    const { kept, decisions } = applyAdaptiveConfidenceFilter([
      candidate({ path: 'A/1', resourceName: 'A' }, { denseDistance: 0.4 }),
      candidate(
        { path: 'B/1', resourceName: 'B' },
        { denseDistance: 0.68, lexicalRank: 1, lexicalMatchedTerms: 2 },
      ),
    ]);
    expect(kept.map((c) => c.path)).toEqual(['A/1', 'B/1']);
    expect(decisions[1].reason).toBe('vector+lexical');
  });

  it('does not let a single common word rescue a middling vector hit', () => {
    // "안내"처럼 흔한 단어 하나가 여러 필드에 있어 점수만 높은 경우
    const { kept, decisions } = applyAdaptiveConfidenceFilter(
      [
        candidate({ path: 'A/1', resourceName: 'A' }, { denseDistance: 0.4 }),
        candidate(
          { path: 'B/1', resourceName: 'B' },
          { denseDistance: 0.68, lexicalRank: 1, lexicalMatchedTerms: 1 },
        ),
      ],
      { queryTermCount: 3 },
    );
    expect(kept.map((c) => c.path)).toEqual(['A/1']);
    expect(decisions[1].reason).toBe('weak-support');
  });

  it('accepts lexical support once enough distinct terms match', () => {
    const { kept, decisions } = applyAdaptiveConfidenceFilter(
      [
        candidate({ path: 'A/1', resourceName: 'A' }, { denseDistance: 0.4 }),
        candidate(
          { path: 'B/1', resourceName: 'B' },
          { denseDistance: 0.68, lexicalRank: 1, lexicalMatchedTerms: 2 },
        ),
      ],
      { queryTermCount: 3 },
    );
    expect(kept.map((c) => c.path)).toEqual(['A/1', 'B/1']);
    expect(decisions[1].reason).toBe('vector+lexical');
  });

  it('still accepts a single match when the query has only one term', () => {
    const { kept } = applyAdaptiveConfidenceFilter(
      [
        candidate({ path: 'A/1', resourceName: 'A' }, { denseDistance: 0.4 }),
        candidate(
          { path: 'B/1', resourceName: 'B' },
          { denseDistance: 0.68, lexicalRank: 1, lexicalMatchedTerms: 1 },
        ),
      ],
      { queryTermCount: 1 },
    );
    expect(kept.map((c) => c.path)).toEqual(['A/1', 'B/1']);
  });

  it('drops a middling vector hit with no lexical or exact support', () => {
    const { kept, decisions } = applyAdaptiveConfidenceFilter([
      candidate({ path: 'A/1', resourceName: 'A' }, { denseDistance: 0.4 }),
      candidate({ path: 'B/1', resourceName: 'B' }, { denseDistance: 0.72 }),
    ]);
    expect(kept.map((c) => c.path)).toEqual(['A/1']);
    expect(decisions[1].reason).toBe('weak-support');
  });

  it('keeps a candidate that ties the best hit even past the strong threshold', () => {
    const { kept, decisions } = applyAdaptiveConfidenceFilter([
      candidate({ path: 'A/1', resourceName: 'A' }, { denseDistance: 0.62 }),
      candidate({ path: 'B/1', resourceName: 'B' }, { denseDistance: 0.66 }),
    ]);
    expect(kept).toHaveLength(2);
    expect(decisions.map((d) => d.reason)).toEqual([
      'near-best-vector',
      'near-best-vector',
    ]);
  });

  it('never empties the result while the best hit is inside the distance ceiling', () => {
    const { kept } = applyAdaptiveConfidenceFilter([
      candidate({ path: 'A/1', resourceName: 'A' }, { denseDistance: 0.74 }),
    ]);
    expect(kept.map((c) => c.path)).toEqual(['A/1']);
  });

  it('drops everything for an unrelated query with no exact evidence', () => {
    const { kept, decisions } = applyAdaptiveConfidenceFilter([
      candidate({ path: 'A/1', resourceName: 'A' }, { denseDistance: 0.88 }),
      candidate({ path: 'B/1', resourceName: 'B' }, { denseDistance: 0.91 }),
    ]);
    expect(kept).toEqual([]);
    expect(decisions.every((d) => d.reason === 'distance-ceiling')).toBe(true);
  });

  it('rescues a lexical-only candidate carrying a title-strength exact match', () => {
    const { kept, decisions } = applyAdaptiveConfidenceFilter([
      candidate(
        { path: 'A/1', resourceName: 'A' },
        { lexicalRank: 1, exactScore: EXACT_FIELD_WEIGHTS.title },
      ),
    ]);
    expect(kept).toHaveLength(1);
    expect(decisions[0].reason).toBe('strong-exact');
  });

  it('drops a lexical-only candidate with only generic word overlap', () => {
    const { kept, decisions } = applyAdaptiveConfidenceFilter([
      candidate({ path: 'A/1', resourceName: 'A' }, { lexicalRank: 1 }),
    ]);
    expect(kept).toEqual([]);
    expect(decisions[0].reason).toBe('lexical-only-weak');
  });
});

describe('enforceDocumentDiversity', () => {
  it('gives every document one slot before any document gets a second', () => {
    const candidates = [
      candidate({ path: 'A/1', resourceName: 'A' }),
      candidate({ path: 'A/2', resourceName: 'A' }),
      candidate({ path: 'A/3', resourceName: 'A' }),
      candidate({ path: 'B/1', resourceName: 'B' }),
      candidate({ path: 'C/1', resourceName: 'C' }),
    ];

    expect(
      enforceDocumentDiversity(candidates, {
        limit: 4,
        maxPerDocument: 2,
      }).map((c) => c.path),
    ).toEqual(['A/1', 'B/1', 'C/1', 'A/2']);
  });

  it('never exceeds the per-document cap', () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      candidate({ path: `A/${index}`, resourceName: 'A' }),
    );
    expect(
      enforceDocumentDiversity(candidates, { limit: 5, maxPerDocument: 2 }),
    ).toHaveLength(2);
  });

  it('does not treat the same path in two documents as a duplicate', () => {
    const selected = enforceDocumentDiversity(
      [
        candidate({ path: '개요', resourceName: 'A', documentId: 'doc-a' }),
        candidate({ path: '개요', resourceName: 'B', documentId: 'doc-b' }),
      ],
      { limit: 5, maxPerDocument: 2 },
    );
    expect(selected).toHaveLength(2);
  });

  it('deduplicates repeated paths', () => {
    const duplicate = candidate({ path: 'A/1', resourceName: 'A' });
    expect(
      enforceDocumentDiversity([duplicate, { ...duplicate }], {
        limit: 5,
        maxPerDocument: 2,
      }),
    ).toHaveLength(1);
  });

  it('returns nothing for a non-positive limit', () => {
    expect(
      enforceDocumentDiversity(
        [candidate({ path: 'A/1', resourceName: 'A' })],
        {
          limit: 0,
        },
      ),
    ).toEqual([]);
  });
});
