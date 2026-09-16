import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  SQL,
} from 'drizzle-orm';
import {
  CHUNK_EMBEDDING_DIMENSIONS,
  DB_CONNECTION,
  documents,
  documentChunks,
} from '../db';
import type { Database } from '../db';
import type { DenseHit } from './rank-fusion';

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

/** 챗 검색 대상 문서 조건(ready · 활성 · 미만료). */
function searchableDocumentCondition(): SQL | undefined {
  return and(
    eq(documents.status, 'ready'),
    eq(documents.isActive, true),
    notExpiredCondition(),
  );
}

/**
 * HNSW 인덱스(migration 0017)와 같은 식으로 코사인 거리를 계산합니다.
 *
 * embedding은 vector(3072)인데 pgvector의 HNSW는 vector를 2000차원까지만
 * 인덱싱하므로, 인덱스를 halfvec(반정밀도, 상한 4000차원) 캐스팅으로 만들었습니다.
 * 질의도 같은 식이어야 플래너가 인덱스를 사용합니다.
 */
export function halfvecCosineDistance(embedding: number[]): SQL<number> {
  const literal = `[${embedding.join(',')}]`;
  return sql<number>`(${documentChunks.embedding}::halfvec(${sql.raw(String(CHUNK_EMBEDDING_DIMENSIONS))}) <=> ${literal}::halfvec(${sql.raw(String(CHUNK_EMBEDDING_DIMENSIONS))}))`;
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
   * 거리 계산은 HNSW 인덱스(migration 0017)와 동일한 halfvec 캐스팅 식을 씁니다.
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
