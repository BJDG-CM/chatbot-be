/**
 * usage_daily.total_answers / bad_answers 백필 로직 (테스트 가능한 순수/트랜잭션 함수).
 *
 * CLI 진입점은 side effect가 있으므로 별도 파일(backfill-usage-answers.ts)에 두고,
 * 여기서는 import 시 부작용이 없는 함수만 export 한다.
 *
 * 동시성 보호:
 *   백필은 단일 트랜잭션 안에서 관련 테이블을 SHARE ROW EXCLUSIVE 모드로 잠근 뒤
 *   조회 → bucket 계산 → usage_daily 절대값 upsert → commit 한다.
 *   SHARE ROW EXCLUSIVE는 일반 INSERT/UPDATE/DELETE가 잡는 ROW EXCLUSIVE와 충돌하므로,
 *   백필이 rows를 읽고 절대값으로 덮어쓰는 사이에 새 집계 쓰기가 끼어들어 유실되는
 *   race condition을 제거한다. (SELECT는 차단하지 않는다.)
 */
import { eq, sql } from 'drizzle-orm';
import {
  type Database,
  messageFeedbacks,
  messages,
  sessions,
  usageDaily,
} from '../db';
import { getSourceFromPageUrl } from '../common/utils/domain-validator.util';

/** 백필 집계에 필요한 assistant 답변 원본 행 */
export interface UsageAnswerRow {
  widgetKeyId: string;
  pageUrl: string;
  createdAt: Date;
  rating: 'GOOD' | 'BAD' | null;
}

/** (widget_key, date, domain) 단위로 집계된 결과 */
export interface UsageAnswerBucket {
  widgetKeyId: string;
  date: string;
  domain: string;
  totalAnswers: number;
  badAnswers: number;
}

export interface RunBackfillResult {
  processed: number;
  applied: number;
}

export interface RunBackfillOptions {
  lockTimeoutMs?: number;
  logger?: (message: string) => void;
}

/** 기본 lock 대기 시간(ms). 잠금 획득이 지연되면 이 시간 후 명확히 실패한다. */
export const DEFAULT_BACKFILL_LOCK_TIMEOUT_MS = 30_000;

/**
 * bucket key. 실제 제어 문자(NUL 등)를 쓰지 않고 JSON 직렬화하여
 * 어떤 값 조합에서도 구분자 충돌이 없고 diff 도구가 바이너리로 오해하지 않게 한다.
 */
export function makeUsageBucketKey(
  widgetKeyId: string,
  date: string,
  domain: string,
): string {
  return JSON.stringify([widgetKeyId, date, domain]);
}

/**
 * assistant 답변 원본 행들을 (widget_key, date, domain) bucket으로 집계한다.
 * - date: created_at의 UTC 날짜 (앱의 incrementTotalAnswers와 동일 버킷)
 * - domain: getSourceFromPageUrl(page_url) (SQL 중복 구현 없이 앱과 동일)
 * - total_answers: assistant 메시지 수
 * - bad_answers: BAD 피드백이 달린 메시지 수 (GOOD / 피드백 없음은 제외)
 */
export function aggregateUsageAnswerRows(
  rows: UsageAnswerRow[],
): UsageAnswerBucket[] {
  const buckets = new Map<string, UsageAnswerBucket>();

  for (const row of rows) {
    const date = new Date(row.createdAt).toISOString().slice(0, 10);
    const domain = getSourceFromPageUrl(row.pageUrl);
    const key = makeUsageBucketKey(row.widgetKeyId, date, domain);

    const bucket = buckets.get(key) ?? {
      widgetKeyId: row.widgetKeyId,
      date,
      domain,
      totalAnswers: 0,
      badAnswers: 0,
    };
    bucket.totalAnswers += 1;
    if (row.rating === 'BAD') {
      bucket.badAnswers += 1;
    }
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values());
}

/**
 * 백필 본체. 단일 트랜잭션 + 테이블 잠금으로 online 실행이 가능하며,
 * 절대값 SET upsert라 여러 번 실행해도 멱등하다.
 * total_tokens / total_requests는 절대 변경하지 않는다.
 */
export async function runBackfill(
  db: Database,
  options: RunBackfillOptions = {},
): Promise<RunBackfillResult> {
  const lockTimeoutMs = Math.trunc(
    options.lockTimeoutMs ?? DEFAULT_BACKFILL_LOCK_TIMEOUT_MS,
  );
  const log = options.logger ?? ((message: string) => console.log(message));

  return db.transaction(async (tx) => {
    log(
      `[backfill-usage-answers] acquiring SHARE ROW EXCLUSIVE lock on messages/message_feedbacks/usage_daily; ` +
        `new answer/feedback writes will wait up to ${lockTimeoutMs}ms while the backfill runs...`,
    );

    // 잠금 획득이 지연되면 무한 대기하지 않고 명확히 실패하도록 lock_timeout을 트랜잭션 범위로 설정.
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${lockTimeoutMs}`));

    // 조회 전에 관련 테이블을 잠가, 읽고 절대값으로 덮어쓰는 사이 새 집계 쓰기가 끼어들지 못하게 한다.
    await tx.execute(
      sql`LOCK TABLE ${messages}, ${messageFeedbacks}, ${usageDaily} IN SHARE ROW EXCLUSIVE MODE`,
    );

    // created_at을 Date로 받아 앱과 동일한 UTC 날짜 버킷팅을 보장한다.
    const rows = await tx
      .select({
        createdAt: messages.createdAt,
        widgetKeyId: sessions.widgetKeyId,
        pageUrl: sessions.pageUrl,
        rating: messageFeedbacks.rating,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .leftJoin(messageFeedbacks, eq(messageFeedbacks.messageId, messages.id))
      .where(eq(messages.role, 'assistant'));

    const buckets = aggregateUsageAnswerRows(rows as UsageAnswerRow[]);

    for (const bucket of buckets) {
      // 절대값 SET → 재실행 안전(멱등). total_tokens/total_requests는 set에 없으므로 미변경.
      // usage_daily 행이 없던 (assistant 있음) bucket은 새 행으로 생성된다.
      await tx
        .insert(usageDaily)
        .values({
          widgetKeyId: bucket.widgetKeyId,
          date: bucket.date,
          domain: bucket.domain,
          totalAnswers: bucket.totalAnswers,
          badAnswers: bucket.badAnswers,
        })
        .onConflictDoUpdate({
          target: [usageDaily.widgetKeyId, usageDaily.date, usageDaily.domain],
          set: {
            totalAnswers: bucket.totalAnswers,
            badAnswers: bucket.badAnswers,
          },
        });
    }

    log(
      `[backfill-usage-answers] processed ${rows.length} assistant message(s) into ${buckets.length} usage_daily row(s).`,
    );

    return { processed: rows.length, applied: buckets.length };
  });
}
