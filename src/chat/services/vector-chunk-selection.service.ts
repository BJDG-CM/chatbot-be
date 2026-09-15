import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from '../../embedding/embedding.service';
import { RetrievalService } from '../../retrieval/retrieval.service';
import { extractQuerySignals } from '../../retrieval/query-signals';
import {
  applyAdaptiveConfidenceFilter,
  enforceDocumentDiversity,
  fuseRankings,
  type DenseHit,
  type RetrievalCandidate,
} from '../../retrieval/rank-fusion';
import {
  DENSE_CANDIDATE_LIMIT,
  FINAL_CHUNK_LIMIT,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_VECTOR_DISTANCE,
  STRONG_VECTOR_DISTANCE,
} from '../../retrieval/retrieval.constants';
import type { RelevantChunkSelection } from './resource-selection.service';

/**
 * LLM을 쓰지 않는 chunk 선별.
 *
 *   질의 → 정규화·exact 신호 추출
 *        → dense Top-K(벡터)
 *        → RRF 순위 융합 (dense 순위 + exact 가점)
 *        → 적응형 신뢰도 필터
 *        → 문서 다양성 정책
 *        → 최종 4~5개 + 루트 개요 chunk
 *
 * 설계 의도
 * - 후보 생성은 recall 우선(기본 20개), 최종 선택은 precision 우선(기본 5개).
 *   코사인 최근접 5개가 항상 최선의 컨텍스트는 아니기 때문입니다.
 * - 검색·선별 단계에 LLM이나 cross-encoder를 쓰지 않아 지연이 벡터 전용 경로와 비슷합니다.
 *
 * 반환값 규약(PR #51과 동일하게 유지)
 * - null        = 벡터 검색 불가(비활성화/임베딩 실패/미백필) → 호출부가 LLM 선별로 폴백
 * - 빈 선택     = 후보는 있었으나 전부 신뢰도 미달 → 관련 자료 없음
 */
@Injectable()
export class VectorChunkSelectionService {
  private readonly logger = new Logger(VectorChunkSelectionService.name);

  private readonly enabled: boolean;
  private readonly maxDistance: number;
  private readonly strongDistance: number;
  private readonly denseCandidateLimit: number;
  private readonly maxChunksPerDocument: number;

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly retrievalService: RetrievalService,
    configService: ConfigService,
  ) {
    this.enabled = !isFalse(
      configService.get<string>('EMBEDDING_RETRIEVAL_ENABLED', 'true'),
    );
    this.maxDistance = positiveNumber(
      configService.get<string>('EMBEDDING_MAX_DISTANCE'),
      MAX_VECTOR_DISTANCE,
    );
    this.strongDistance = Math.min(
      positiveNumber(
        configService.get<string>('RETRIEVAL_STRONG_DISTANCE'),
        STRONG_VECTOR_DISTANCE,
      ),
      this.maxDistance,
    );
    this.denseCandidateLimit = positiveNumber(
      configService.get<string>('RETRIEVAL_DENSE_CANDIDATE_LIMIT'),
      DENSE_CANDIDATE_LIMIT,
    );
    this.maxChunksPerDocument = positiveNumber(
      configService.get<string>('RETRIEVAL_MAX_CHUNKS_PER_DOCUMENT'),
      MAX_CHUNKS_PER_DOCUMENT,
    );
  }

  async selectRelevantChunkPaths(
    question: string,
    maxResults: number = FINAL_CHUNK_LIMIT,
  ): Promise<RelevantChunkSelection | null> {
    if (!this.enabled || !this.embeddingService.isEnabled()) {
      return null;
    }

    const startedAt = Date.now();
    const signals = extractQuerySignals(question);

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embeddingService.embedText(question);
    } catch {
      this.logger.warn('Question embedding failed; falling back to LLM');
      return null;
    }

    let denseHits: DenseHit[];
    try {
      denseHits = await this.retrievalService.searchChunksByEmbedding(
        queryEmbedding,
        this.denseCandidateLimit,
      );
    } catch (error) {
      this.logger.warn(
        `Vector search failed; falling back to LLM: ${describeError(error)}`,
      );
      return null;
    }

    const searchMs = Date.now() - startedAt;

    if (denseHits.length === 0) {
      // 임베딩된 chunk가 하나도 없는 상태(백필 전 등) — LLM 선별로 폴백
      this.logger.warn('No embedded chunks available; falling back to LLM');
      return null;
    }

    const candidates = fuseRankings({
      denseHits,
      exactSignals: signals.exactSignals,
    });

    const { kept, decisions } = applyAdaptiveConfidenceFilter(candidates, {
      maxDistance: this.maxDistance,
      strongDistance: this.strongDistance,
    });

    // 루트 개요 chunk는 세부 chunk 쿼터를 소비하지 않습니다.
    const rootHits = kept.filter((candidate) => candidate.isRoot);
    const detailCandidates = kept.filter((candidate) => !candidate.isRoot);

    const selected = enforceDocumentDiversity(detailCandidates, {
      maxPerDocument: this.maxChunksPerDocument,
      limit: maxResults,
    });

    const rootPaths = new Set<string>();
    for (const root of rootHits.slice(0, maxResults)) {
      rootPaths.add(root.path);
    }
    const detailPaths: string[] = [];
    for (const candidate of selected) {
      detailPaths.push(candidate.path);
      // 세부 chunk 선택 시 루트 개요도 함께 참조 (PR #51 / LLM 선별과 동일한 동작)
      rootPaths.add(candidate.resourceName);
    }

    this.logRetrieval({
      signals,
      denseHits,
      candidates,
      decisions,
      selected,
      rootPaths: [...rootPaths],
      searchMs,
      totalMs: Date.now() - startedAt,
    });

    return { rootPaths: [...rootPaths], detailPaths };
  }

  /**
   * 검색 판단 근거를 남깁니다. 문서 본문은 로드하지도 기록하지도 않고,
   * 경로·순위·점수 등 판단에 필요한 메타데이터만 남깁니다.
   */
  private logRetrieval(info: {
    signals: ReturnType<typeof extractQuerySignals>;
    denseHits: DenseHit[];
    candidates: RetrievalCandidate[];
    decisions: ReturnType<typeof applyAdaptiveConfidenceFilter>['decisions'];
    selected: RetrievalCandidate[];
    rootPaths: string[];
    searchMs: number;
    totalMs: number;
  }): void {
    const bestDistance = info.denseHits[0]?.distance;
    this.logger.log(
      `[PERF] vector chunk selection: ${info.totalMs}ms (embed+search ${info.searchMs}ms)`,
    );
    this.logger.log(
      `[DEBUG] 벡터 선별: dense ${info.denseHits.length}개(최소 거리 ${
        bestDistance != null ? bestDistance.toFixed(3) : 'n/a'
      }), 융합 후보 ${info.candidates.length}개 → ` +
        `통과 ${info.decisions.filter((d) => d.keep).length}개 → 최종 세부 ${info.selected.length}개 / 루트 ${info.rootPaths.length}개`,
    );

    if (info.signals.exactSignals.length > 0) {
      this.logger.debug(
        `[DEBUG] exact 신호: ${info.signals.exactSignals
          .map((signal) => `${signal.value}(${signal.kind})`)
          .join(', ')}`,
      );
    }

    for (const decision of info.decisions.slice(0, 10)) {
      const candidate = decision.candidate;
      this.logger.debug(
        `[DEBUG] ${decision.keep ? 'KEEP' : 'DROP'} ${candidate.path} ` +
          `rrf=${candidate.fusedScore.toFixed(5)} ` +
          `dense=${candidate.denseRank ?? '-'}/${candidate.denseDistance?.toFixed(3) ?? '-'} ` +
          `exact=${candidate.exactRank ?? '-'}/${candidate.exactScore}` +
          `${candidate.exactMatches.length ? `[${candidate.exactMatches.join('|')}]` : ''} ` +
          `reason=${decision.reason}`,
      );
    }
  }
}

function isFalse(value: string | undefined): boolean {
  return String(value).toLowerCase() === 'false';
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
