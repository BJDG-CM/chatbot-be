import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import {
  CHUNK_EMBEDDING_DIMENSIONS,
  DB_CONNECTION,
  documents,
  documentChunks,
} from '../db';
import type { Database } from '../db';
import type { DenseHit, LexicalHit } from './rank-fusion';
import {
  LEXICAL_EXACT_TERM_MULTIPLIER,
  LEXICAL_FIELD_WEIGHTS,
} from './retrieval.constants';

export type ReadyDocumentWithChunks = {
  id: string;
  title: string;
  resourceName: string;
  summary: string | null;
  chunks: Array<{
    path: string;
    description: string;
    sortOrder: number;
  }>;
};

/**
 * Chat catalog/content eligibility: null expiresAt = never expires.
 */
export function notExpiredCondition(now: Date = new Date()): SQL | undefined {
  return or(isNull(documents.expiresAt), gt(documents.expiresAt, now));
}

export function isExpiredAt(
  expiresAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return expiresAt != null && expiresAt.getTime() <= now.getTime();
}

/** 챗 검색 대상 문서 조건(ready · 활성 · 미만료). dense/lexical 양쪽에서 동일하게 적용합니다. */
function searchableDocumentCondition(): SQL | undefined {
  return and(
    eq(documents.status, 'ready'),
    eq(documents.isActive, true),
    notExpiredCondition(),
  );
}

/**
 * HNSW 인덱스(migration 0018)와 같은 식으로 코사인 거리를 계산합니다.
 *
 * embedding은 vector(3072)인데 pgvector의 HNSW는 vector를 2000차원까지만
 * 인덱싱하므로, 인덱스를 halfvec(반정밀도, 상한 4000차원) 캐스팅으로 만들었습니다.
 * 질의도 같은 식이어야 플래너가 인덱스를 사용합니다.
 */
export function halfvecCosineDistance(embedding: number[]): SQL<number> {
  const literal = `[${embedding.join(',')}]`;
  return sql<number>`(${documentChunks.embedding}::halfvec(${sql.raw(String(CHUNK_EMBEDDING_DIMENSIONS))}) <=> ${literal}::halfvec(${sql.raw(String(CHUNK_EMBEDDING_DIMENSIONS))}))`;
}

/** ILIKE 패턴으로 감싸면서 와일드카드 문자를 이스케이프합니다. */
export function toLikePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * lexical 검색의 점수식과 매칭 조건을 만듭니다.
 *
 * 필드별 가중치는 retrieval.constants.ts에 모여 있고, exact 신호에는 배수를 곱합니다.
 * 본문(content)은 exact 신호에 대해서만, 그것도 가장 낮은 가중치로 검사합니다 —
 * 일반 어휘까지 본문에서 찾으면 거의 모든 chunk가 걸려 변별력이 사라지기 때문입니다.
 *
 * 순수 함수로 분리해 두어 DB 없이도 생성되는 SQL을 검증할 수 있습니다.
 */
export function buildLexicalScoreSql(
  terms: string[],
  exactTerms: string[],
): { score: SQL<number>; matchedTerms: SQL<number>; match: SQL } | null {
  if (terms.length === 0) return null;

  const exactSet = new Set(exactTerms.map((term) => term.toLowerCase()));
  const scoreParts: SQL[] = [];
  const matchConditions: SQL[] = [];
  /** 검색어별로 "어느 필드든 하나라도 맞았는가"를 1/0으로 세는 항 */
  const matchedTermParts: SQL[] = [];

  // 본문(content)을 제외한 메타데이터 필드와 가중치
  const weightedFields: Array<[SQLWrapper, number]> = [
    [documents.title, LEXICAL_FIELD_WEIGHTS.title],
    [documentChunks.path, LEXICAL_FIELD_WEIGHTS.path],
    [documentChunks.description, LEXICAL_FIELD_WEIGHTS.description],
    [documents.summary, LEXICAL_FIELD_WEIGHTS.summary],
  ];

  const addTerm = (
    term: string,
    fields: Array<[SQLWrapper, number]>,
    multiplier: number,
    /**
     * 매칭된 검색어 수에 포함할지 여부.
     * 본문 전용 항은 이미 메타데이터에서 센 검색어를 다시 세지 않도록 제외합니다.
     */
    countAsTerm = true,
  ) => {
    const pattern = toLikePattern(term);
    const termConditions: SQL[] = [];
    for (const [column, fieldWeight] of fields) {
      // 가중치는 내부 상수이므로 리터럴로 넣어 파라미터 타입 추론 문제를 피합니다.
      const weight = sql.raw(String(fieldWeight * multiplier));
      scoreParts.push(
        sql`(CASE WHEN ${column} ILIKE ${pattern} THEN ${weight} ELSE 0 END)`,
      );
      termConditions.push(sql`${column} ILIKE ${pattern}`);
    }
    matchConditions.push(...termConditions);
    const anyField = or(...termConditions);
    if (countAsTerm && anyField) {
      matchedTermParts.push(sql`(CASE WHEN ${anyField} THEN 1 ELSE 0 END)`);
    }
  };

  for (const term of terms) {
    addTerm(
      term,
      weightedFields,
      exactSet.has(term.toLowerCase()) ? LEXICAL_EXACT_TERM_MULTIPLIER : 1,
    );
  }

  for (const term of exactTerms) {
    addTerm(
      term,
      [[documentChunks.content, LEXICAL_FIELD_WEIGHTS.content]],
      LEXICAL_EXACT_TERM_MULTIPLIER,
      false,
    );
  }

  const match = or(...matchConditions);
  if (!match) return null;

  return {
    score: sql<number>`(${sql.join(scoreParts, sql` + `)})`,
    matchedTerms: matchedTermParts.length
      ? sql<number>`(${sql.join(matchedTermParts, sql` + `)})`
      : sql<number>`0`,
    match,
  };
}

@Injectable()
export class RetrievalRepository {
  constructor(@Inject(DB_CONNECTION) private readonly db: Database) {}

  /**
   * Ready + active + not-expired documents that have at least one chunk.
   */
  async listReadyWithChunks(): Promise<ReadyDocumentWithChunks[]> {
    const rows = await this.db
      .select({
        documentId: documents.id,
        title: documents.title,
        resourceName: documents.resourceName,
        summary: documents.summary,
        chunkId: documentChunks.id,
        chunkPath: documentChunks.path,
        chunkDescription: documentChunks.description,
        chunkSortOrder: documentChunks.sortOrder,
      })
      .from(documents)
      .innerJoin(documentChunks, eq(documentChunks.documentId, documents.id))
      .where(
        and(
          eq(documents.status, 'ready'),
          eq(documents.isActive, true),
          notExpiredCondition(),
        ),
      )
      .orderBy(asc(documents.createdAt), asc(documentChunks.sortOrder));

    const byId = new Map<string, ReadyDocumentWithChunks>();
    for (const row of rows) {
      let doc = byId.get(row.documentId);
      if (!doc) {
        doc = {
          id: row.documentId,
          title: row.title,
          resourceName: row.resourceName,
          summary: row.summary,
          chunks: [],
        };
        byId.set(row.documentId, doc);
      }
      doc.chunks.push({
        path: row.chunkPath,
        description: row.chunkDescription,
        sortOrder: row.chunkSortOrder,
      });
    }

    return [...byId.values()];
  }

  /**
   * 질의 임베딩과의 코사인 거리 기준 상위 chunk 검색.
   * embedding이 없는 chunk(미백필)는 후보에서 제외됩니다.
   *
   * 랭킹에 필요한 메타데이터(title/summary/description/sortOrder)를 함께 돌려주지만
   * 본문(content)은 포함하지 않습니다 — 후보 단계에서 큰 텍스트를 메모리로 끌어오지 않기 위함입니다.
   *
   * 거리 계산은 HNSW 인덱스(migration 0018)와 동일한 halfvec 캐스팅 식을 씁니다.
   * 식이 다르면 인덱스를 타지 못하고 전체 chunk를 순차 스캔합니다.
   */
  async searchChunksByEmbedding(
    embedding: number[],
    limit: number,
  ): Promise<DenseHit[]> {
    if (embedding.length === 0 || limit < 1) return [];

    const distance = halfvecCosineDistance(embedding);
    const rows = await this.db
      .select({
        path: documentChunks.path,
        documentId: documentChunks.documentId,
        description: documentChunks.description,
        sortOrder: documentChunks.sortOrder,
        resourceName: documents.resourceName,
        title: documents.title,
        summary: documents.summary,
        distance,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(
        and(isNotNull(documentChunks.embedding), searchableDocumentCondition()),
      )
      .orderBy(distance)
      .limit(limit);

    return rows.map((row) => ({
      path: row.path,
      documentId: row.documentId,
      description: row.description,
      sortOrder: row.sortOrder,
      resourceName: row.resourceName,
      title: row.title,
      summary: row.summary,
      distance: Number(row.distance),
    }));
  }

  /**
   * 어휘(문자열 포함) 기준 상위 chunk 검색.
   *
   * 벡터 검색이 놓치는 과목코드·연도·학기·날짜 같은 토큰을 잡기 위한 경로입니다.
   * 점수 계산과 정렬·상한은 모두 DB에서 처리하고(대용량 content를 애플리케이션으로
   * 끌어오지 않음), 필드별 가중치는 retrieval.constants.ts에 모아두었습니다.
   *
   * - title/path: 매우 강함
   * - description/summary: 강함
   * - content: 약함. 게다가 exact 신호(과목코드·연도 등)에 대해서만 검사합니다.
   *   일반 어휘까지 본문에서 찾으면 거의 모든 chunk가 걸려 변별력이 사라집니다.
   *
   * ILIKE '%…%'는 pg_trgm GIN 인덱스(migration 0017)로 가속됩니다.
   */
  async searchChunksByLexical(
    terms: string[],
    exactTerms: string[],
    limit: number,
  ): Promise<LexicalHit[]> {
    if (terms.length === 0 || limit < 1) return [];

    const lexical = buildLexicalScoreSql(terms, exactTerms);
    if (!lexical) return [];
    const { score, matchedTerms, match } = lexical;

    const rows = await this.db
      .select({
        path: documentChunks.path,
        documentId: documentChunks.documentId,
        description: documentChunks.description,
        sortOrder: documentChunks.sortOrder,
        resourceName: documents.resourceName,
        title: documents.title,
        summary: documents.summary,
        score,
        matchedTerms,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(and(match, searchableDocumentCondition()))
      .orderBy(desc(score), asc(documentChunks.sortOrder))
      .limit(limit);

    return rows.map((row) => ({
      path: row.path,
      documentId: row.documentId,
      description: row.description,
      sortOrder: row.sortOrder,
      resourceName: row.resourceName,
      title: row.title,
      summary: row.summary,
      score: Number(row.score),
      matchedTerms: Number(row.matchedTerms),
    }));
  }

  async findChunkContentsByPaths(
    paths: string[],
  ): Promise<Array<{ path: string; content: string }>> {
    if (paths.length === 0) return [];

    const uniquePaths = [...new Set(paths)];
    const rows = await this.db
      .select({
        path: documentChunks.path,
        content: documentChunks.content,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(
        and(
          inArray(documentChunks.path, uniquePaths),
          eq(documents.status, 'ready'),
          eq(documents.isActive, true),
          notExpiredCondition(),
        ),
      );

    return rows;
  }
}
