/**
 * dense(벡터) · exact(결정적 신호) 두 순위를 합치고,
 * 신뢰도 필터와 문서 다양성 정책을 적용하는 순수 함수 모음.
 *
 * DB/NestJS에 의존하지 않으므로 랭킹 로직만 따로 단위 테스트할 수 있습니다.
 * Repository는 "후보를 가져오는 것"까지만 담당합니다.
 */
import {
  EXACT_FIELD_WEIGHTS,
  FINAL_CHUNK_LIMIT,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_VECTOR_DISTANCE,
  RRF_DENSE_WEIGHT,
  RRF_EXACT_WEIGHT,
  RRF_K,
  STRONG_EXACT_SCORE,
  STRONG_VECTOR_DISTANCE,
  VECTOR_DISTANCE_MARGIN,
} from './retrieval.constants';
import { matchExactSignals, type ExactSignal } from './query-signals';

/** dense 검색이 돌려주는 후보 메타데이터. 본문(content)은 포함하지 않습니다. */
export type CandidateMetadata = {
  path: string;
  documentId: string;
  resourceName: string;
  title: string;
  summary: string | null;
  description: string;
  sortOrder: number;
};

/**
 * chunk를 유일하게 식별하는 복합키.
 * `document_chunks`의 유일성 제약이 (documentId, path)이므로 path 하나로는 부족합니다.
 */
export function candidateKey(
  meta: Pick<CandidateMetadata, 'documentId' | 'path'>,
): string {
  return `${meta.documentId}::${meta.path}`;
}

export type DenseHit = CandidateMetadata & { distance: number };

export type RetrievalCandidate = CandidateMetadata & {
  /** 문서 전체 개요 chunk 여부 (path === resourceName) */
  isRoot: boolean;

  denseRank?: number;
  denseDistance?: number;

  exactRank?: number;
  exactScore: number;
  exactMatches: string[];

  fusedScore: number;
};

export type FuseRankingsInput = {
  denseHits: DenseHit[];
  exactSignals: ExactSignal[];
  weights?: {
    dense?: number;
    exact?: number;
    k?: number;
  };
};

/**
 * Reciprocal Rank Fusion 항. 순위가 없으면(해당 검색에 잡히지 않았으면) 0을 더합니다.
 * 원식: score = Σ weight / (k + rank)
 */
export function reciprocalRankTerm(
  rank: number | undefined,
  weight: number,
  k: number,
): number {
  if (rank == null || !Number.isFinite(rank) || rank < 1) return 0;
  return weight / (k + rank);
}

/**
 * 동점자에게 같은 순위를 주는 competition ranking (1, 2, 2, 4 …).
 * 점수가 같은데 순위가 갈려 결과가 흔들리는 것을 막습니다.
 */
function assignCompetitionRanks(scores: number[]): number[] {
  const order = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score);

  const ranks = new Array<number>(scores.length).fill(0);
  let previousScore = Number.NaN;
  let previousRank = 0;
  order.forEach((entry, position) => {
    const rank = entry.score === previousScore ? previousRank : position + 1;
    ranks[entry.index] = rank;
    previousScore = entry.score;
    previousRank = rank;
  });
  return ranks;
}

/**
 * 후보 메타데이터에서 exact 신호 매칭 점수를 계산합니다.
 * 본문(content)은 보지 않습니다 — 메타데이터 일치가 훨씬 높은 precision을 갖기 때문입니다.
 */
export function scoreExactMatches(
  candidate: CandidateMetadata,
  signals: ExactSignal[],
): { score: number; matches: string[] } {
  if (signals.length === 0) return { score: 0, matches: [] };

  const fields: Array<[string | null | undefined, number]> = [
    [candidate.title, EXACT_FIELD_WEIGHTS.title],
    [candidate.path, EXACT_FIELD_WEIGHTS.path],
    [candidate.description, EXACT_FIELD_WEIGHTS.description],
    [candidate.summary, EXACT_FIELD_WEIGHTS.summary],
  ];

  let score = 0;
  const matches = new Set<string>();
  for (const [text, weight] of fields) {
    for (const signal of matchExactSignals(text, signals)) {
      score += weight;
      matches.add(signal.value);
    }
  }

  return { score, matches: [...matches] };
}

/**
 * dense 후보에 exact 신호 순위를 더해 RRF 점수를 매깁니다.
 * 과목코드·연도처럼 결정적인 신호가 맞은 후보는 항이 하나 더 붙어 위로 올라옵니다.
 */
export function fuseRankings(input: FuseRankingsInput): RetrievalCandidate[] {
  const k = input.weights?.k ?? RRF_K;
  const denseWeight = input.weights?.dense ?? RRF_DENSE_WEIGHT;
  const exactWeight = input.weights?.exact ?? RRF_EXACT_WEIGHT;

  // chunk의 유일성 제약은 (documentId, path) 조합이므로 path만으로 묶으면
  // 서로 다른 문서의 후보가 하나로 합쳐질 수 있습니다. 복합키로 식별합니다.
  const byKey = new Map<string, RetrievalCandidate>();

  const upsert = (meta: CandidateMetadata): RetrievalCandidate => {
    const key = candidateKey(meta);
    const existing = byKey.get(key);
    if (existing) return existing;
    const candidate: RetrievalCandidate = {
      ...meta,
      isRoot: meta.path === meta.resourceName,
      exactScore: 0,
      exactMatches: [],
      fusedScore: 0,
    };
    byKey.set(key, candidate);
    return candidate;
  };

  input.denseHits.forEach((hit, index) => {
    const candidate = upsert(hit);
    if (candidate.denseRank == null) {
      candidate.denseRank = index + 1;
      candidate.denseDistance = hit.distance;
    }
  });

  const candidates = [...byKey.values()];

  for (const candidate of candidates) {
    const { score, matches } = scoreExactMatches(candidate, input.exactSignals);
    candidate.exactScore = score;
    candidate.exactMatches = matches;
  }

  // exact 점수가 0인 후보는 exact 순위를 갖지 않습니다(가점 신호이므로 감점은 없음).
  const exactRanks = assignCompetitionRanks(
    candidates.map((c) => c.exactScore),
  );
  candidates.forEach((candidate, index) => {
    candidate.exactRank =
      candidate.exactScore > 0 ? exactRanks[index] : undefined;
  });

  for (const candidate of candidates) {
    candidate.fusedScore =
      reciprocalRankTerm(candidate.denseRank, denseWeight, k) +
      reciprocalRankTerm(candidate.exactRank, exactWeight, k);
  }

  return candidates.sort(compareCandidates);
}

/** 결정적 정렬: 융합 점수 → 벡터 거리 → 복합키 순. */
function compareCandidates(
  a: RetrievalCandidate,
  b: RetrievalCandidate,
): number {
  if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
  const aDistance = a.denseDistance ?? Number.POSITIVE_INFINITY;
  const bDistance = b.denseDistance ?? Number.POSITIVE_INFINITY;
  if (aDistance !== bDistance) return aDistance - bDistance;
  // 같은 path를 가진 다른 문서가 있어도 순서가 흔들리지 않도록 복합키로 비교합니다.
  return candidateKey(a).localeCompare(candidateKey(b));
}

export type FilterDecision = {
  candidate: RetrievalCandidate;
  keep: boolean;
  reason: string;
};

export type AdaptiveFilterOptions = {
  maxDistance?: number;
  strongDistance?: number;
  distanceMargin?: number;
  strongExactScore?: number;
};

/**
 * 단일 거리 임계값 대신 여러 신호를 조합한 적응형 필터.
 *
 * 통과 조건
 *  - 벡터 유사도가 충분히 강함 (distance <= strongDistance), 또는
 *  - 벡터 유사도가 허용 범위 안이고(distance <= maxDistance) 다음 중 하나가 성립
 *      · 최상위 후보와 사실상 동률 (distance <= best + margin)
 *      · exact 신호가 맞음
 *  - title/path급 exact 근거가 강함 (exactScore >= strongExactScore)
 *
 * maxDistance 안쪽의 최상위 dense 후보는 margin 규칙에 의해 항상 살아남으므로,
 * 애매한 질의에서 결과가 통째로 비는 일은 발생하지 않습니다.
 * 반대로 모든 후보가 maxDistance 밖이고 exact 근거도 없으면 빈 결과를 돌려줍니다(무관한 질의).
 */
export function applyAdaptiveConfidenceFilter(
  candidates: RetrievalCandidate[],
  options: AdaptiveFilterOptions = {},
): { kept: RetrievalCandidate[]; decisions: FilterDecision[] } {
  const maxDistance = options.maxDistance ?? MAX_VECTOR_DISTANCE;
  const strongDistance = options.strongDistance ?? STRONG_VECTOR_DISTANCE;
  const distanceMargin = options.distanceMargin ?? VECTOR_DISTANCE_MARGIN;
  const strongExactScore = options.strongExactScore ?? STRONG_EXACT_SCORE;

  const distances = candidates
    .map((c) => c.denseDistance)
    .filter((d): d is number => d != null);
  const bestDistance = distances.length
    ? Math.min(...distances)
    : Number.POSITIVE_INFINITY;

  const decisions = candidates.map<FilterDecision>((candidate) => {
    const distance = candidate.denseDistance;
    const hasStrongExact = candidate.exactScore >= strongExactScore;

    if (distance != null) {
      if (distance <= strongDistance) {
        return { candidate, keep: true, reason: 'strong-vector' };
      }
      if (distance <= maxDistance) {
        if (distance <= bestDistance + distanceMargin) {
          return { candidate, keep: true, reason: 'near-best-vector' };
        }
        if (candidate.exactScore > 0) {
          return { candidate, keep: true, reason: 'vector+exact' };
        }
      }
      if (hasStrongExact) {
        return { candidate, keep: true, reason: 'strong-exact' };
      }
      return {
        candidate,
        keep: false,
        reason: distance > maxDistance ? 'distance-ceiling' : 'weak-support',
      };
    }

    if (hasStrongExact) {
      return { candidate, keep: true, reason: 'strong-exact' };
    }
    // dense 후보는 항상 거리를 갖지만, 방어적으로 남겨 둡니다.
    return { candidate, keep: false, reason: 'no-vector-evidence' };
  });

  return {
    kept: decisions.filter((d) => d.keep).map((d) => d.candidate),
    decisions,
  };
}

export type DiversityOptions = {
  maxPerDocument?: number;
  limit?: number;
};

/**
 * 한 문서가 최종 slot을 독점하지 못하게 하는 2-pass 정책.
 *  - 1차: 문서마다 가장 좋은 chunk를 하나씩
 *  - 2차: 남은 자리를 문서당 상한(maxPerDocument)까지 채움
 * MMR 같은 확률적 방법보다 단순하고 결과가 재현 가능합니다.
 */
export function enforceDocumentDiversity(
  candidates: RetrievalCandidate[],
  options: DiversityOptions = {},
): RetrievalCandidate[] {
  const maxPerDocument = options.maxPerDocument ?? MAX_CHUNKS_PER_DOCUMENT;
  const limit = options.limit ?? FINAL_CHUNK_LIMIT;
  if (limit < 1) return [];

  const perDocument = new Map<string, number>();
  const selectedKeys = new Set<string>();
  const selected: RetrievalCandidate[] = [];

  const take = (candidate: RetrievalCandidate) => {
    selectedKeys.add(candidateKey(candidate));
    perDocument.set(
      candidate.documentId,
      (perDocument.get(candidate.documentId) ?? 0) + 1,
    );
    selected.push(candidate);
  };

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(candidateKey(candidate))) continue;
    if (perDocument.has(candidate.documentId)) continue;
    take(candidate);
  }

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (selectedKeys.has(candidateKey(candidate))) continue;
    if ((perDocument.get(candidate.documentId) ?? 0) >= maxPerDocument)
      continue;
    take(candidate);
  }

  return selected;
}
