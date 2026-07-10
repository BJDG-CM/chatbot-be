import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DB_CONNECTION,
  type Database,
  messageFeedbacks,
  messages,
  sessions,
  usageDaily,
  widgetKeys,
  widgetKeyCollaborators,
} from '../db';
import { eq, sql, and, inArray, gte, lt, lte, ne } from 'drizzle-orm';
import { getSourceFromPageUrl } from '../common/utils/domain-validator.util';
import {
  WidgetKeyStatsDto,
  UsageDataDto,
  DomainStatDto,
} from '../common/dto/widget-key-usage.dto';

/**
 * usage_daily에 쓰기 작업을 수행할 실행자(전체 DB 또는 트랜잭션).
 * 메시지/피드백 저장과 집계 갱신을 하나의 트랜잭션으로 묶을 때 tx를 전달한다.
 */
export type UsageDbExecutor =
  | Database
  | Parameters<Parameters<Database['transaction']>[0]>[0];

/** 피드백 rating 값 (usage_daily.bad_answers delta 계산용) */
export type FeedbackRatingValue = 'GOOD' | 'BAD';

/**
 * 채팅 완료 시 사용량을 usage_daily에 기록할 때 전달하는 값
 */
export interface RecordUsageInput {
  totalTokens: number;
}

/** assistant 답변 저장 시 total_answers 집계에 필요한 값 */
export interface AnswerAggregationInput {
  widgetKeyId: string;
  pageUrl: string;
  createdAt: Date;
}

/** 피드백 변경 시 bad_answers 집계에 필요한 값 */
export interface BadAnswerDeltaInput extends AnswerAggregationInput {
  delta: number;
}

export interface GetWidgetKeyUsageOptions {
  widgetKeyId?: string;
  startDate?: string;
  endDate?: string;
  domain?: string;
}

function maskWidgetKey(secretKey: string): string {
  if (secretKey.length <= 10) return '***';
  return secretKey.slice(0, 7) + '***' + secretKey.slice(-3);
}

export function calculateResolutionRate(
  totalAnswers: number,
  badAnswers: number,
): number {
  if (totalAnswers <= 0) {
    return 0;
  }

  const rate = (1 - badAnswers / totalAnswers) * 100;
  return Math.round(rate * 100) / 100;
}

/**
 * 피드백 rating 전이에 따른 bad_answers 변화량을 계산한다.
 * `previous`는 기존 rating(없음=null/undefined, GOOD, BAD), `next`는 새로 저장되는
 * rating(GOOD 또는 BAD; 피드백 삭제 API가 없으므로 next는 항상 값이 있음)이다.
 * - 없음 → BAD: +1
 * - GOOD → BAD: +1
 * - BAD → GOOD: -1
 * - 동일 상태(GOOD→GOOD, BAD→BAD) 또는 없음 → GOOD: 0
 */
export function computeBadAnswerDelta(
  previous: FeedbackRatingValue | null | undefined,
  next: FeedbackRatingValue,
): number {
  const wasBad = previous === 'BAD';
  const isBad = next === 'BAD';
  if (wasBad === isBad) {
    return 0;
  }
  return isBad ? 1 : -1;
}

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(@Inject(DB_CONNECTION) private readonly db: Database) {}

  /**
   * 채팅 스트림 완료 시 호출. 세션에서 widget_key_id와 도메인을 조회한 뒤
   * usage_daily에 오늘 날짜(UTC) 기준으로 토큰/요청 수를 누적한다.
   */
  async recordUsage(sessionId: string, input: RecordUsageInput): Promise<void> {
    const { totalTokens } = input;
    if (totalTokens <= 0) {
      return;
    }

    const [session] = await this.db
      .select({
        widgetKeyId: sessions.widgetKeyId,
        pageUrl: sessions.pageUrl,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!session) {
      this.logger.warn(`Session not found for recordUsage: ${sessionId}`);
      return;
    }

    const domain = getSourceFromPageUrl(session.pageUrl);

    const todayUtc = new Date();
    const dateStr = todayUtc.toISOString().slice(0, 10);

    await this.db
      .insert(usageDaily)
      .values({
        widgetKeyId: session.widgetKeyId,
        date: dateStr,
        domain,
        totalTokens,
        totalRequests: 1,
      })
      .onConflictDoUpdate({
        target: [usageDaily.widgetKeyId, usageDaily.date, usageDaily.domain],
        set: {
          totalTokens: sql`${usageDaily.totalTokens} + ${totalTokens}`,
          totalRequests: sql`${usageDaily.totalRequests} + 1`,
        },
      });
  }

  /**
   * assistant 답변이 실제로 저장됐을 때 total_answers를 1 증가시킨다.
   * 집계 기준은 답변 생성 날짜(UTC)·세션의 widget_key·pageUrl에서 파싱한 domain이다.
   * 토큰 유무와 무관하게 답변이 저장되면 반드시 호출되어야 하므로 recordUsage와 분리되어 있다.
   * 메시지 저장과 원자적으로 처리하려면 executor에 트랜잭션(tx)을 전달한다.
   */
  async incrementTotalAnswers(
    executor: UsageDbExecutor,
    params: AnswerAggregationInput,
  ): Promise<void> {
    const domain = getSourceFromPageUrl(params.pageUrl);
    const dateStr = toUtcDateString(params.createdAt);

    await executor
      .insert(usageDaily)
      .values({
        widgetKeyId: params.widgetKeyId,
        date: dateStr,
        domain,
        totalAnswers: 1,
      })
      .onConflictDoUpdate({
        target: [usageDaily.widgetKeyId, usageDaily.date, usageDaily.domain],
        set: {
          totalAnswers: sql`${usageDaily.totalAnswers} + 1`,
        },
      });
  }

  /**
   * 피드백 변경에 따른 bad_answers delta를 반영한다.
   * 귀속 행은 피드백 등록 시점이 아니라 답변 생성 날짜(UTC)·domain을 기준으로 한다.
   * 반드시 피드백 upsert와 같은 트랜잭션(executor=tx)에서 호출해야 한다.
   *
   * - delta가 0이면 no-op.
   * - 빠른 경로: 집계 행이 이미 존재하고 delta 적용 후에도 불변식(0 <= bad <= total)이
   *   유지되는 행에만 매칭되는 조건부 산술 UPDATE. 하나의 원자적 문이라 같은 bucket에
   *   동시 피드백이 들어와도 lost update가 없다.
   * - 복구 경로: 빠른 경로가 0행이면(집계 행이 없거나, 백필 전이라 total_answers가 아직
   *   반영되지 않아 delta 적용이 불변식을 깨는 경우) source-of-truth에서 해당 bucket을
   *   정확히 재계산해 절대값으로 맞춘다. 500을 던지지 않고 self-heal 하며, source 데이터
   *   기준이라 bad <= total 불변식이 항상 성립한다.
   */
  async applyBadAnswerDelta(
    executor: UsageDbExecutor,
    params: BadAnswerDeltaInput,
  ): Promise<void> {
    if (params.delta === 0) {
      return;
    }

    const domain = getSourceFromPageUrl(params.pageUrl);
    const dateStr = toUtcDateString(params.createdAt);

    // 빠른 경로: delta 적용 후에도 0 <= bad_answers <= total_answers 를 만족하는 행에만
    // 매칭되도록 WHERE에 가드 조건을 건다. 매칭되면 CHECK 위반 없이 산술 갱신으로 끝난다.
    const updated = await executor
      .update(usageDaily)
      .set({
        badAnswers: sql`${usageDaily.badAnswers} + ${params.delta}`,
      })
      .where(
        and(
          eq(usageDaily.widgetKeyId, params.widgetKeyId),
          eq(usageDaily.date, dateStr),
          eq(usageDaily.domain, domain),
          sql`${usageDaily.badAnswers} + ${params.delta} >= 0`,
          sql`${usageDaily.badAnswers} + ${params.delta} <= ${usageDaily.totalAnswers}`,
        ),
      )
      .returning({ id: usageDaily.id });

    if (updated.length > 0) {
      return;
    }

    // 복구 경로: 행이 없거나 total_answers 미반영으로 빠른 경로가 불변식을 지킬 수 없는 경우.
    await this.reconcileAnswerBucketFromSource(executor, {
      widgetKeyId: params.widgetKeyId,
      date: dateStr,
      domain,
    });
  }

  /**
   * 특정 (widget_key, 날짜(UTC), domain) bucket의 total_answers/bad_answers를
   * source-of-truth(messages ⋈ sessions ⟕ message_feedbacks)에서 재계산해 절대값으로 맞춘다.
   *
   * applyBadAnswerDelta의 예외(복구) 경로에서만 호출되는 write-path 전용 targeted scan이다.
   * (대시보드 조회 경로에는 영향이 없다. getWidgetKeyStats는 여전히 usage_daily만 읽는다.)
   *
   * 동시성: bucket 행을 먼저 확보(placeholder insert)하고 FOR UPDATE로 잠근 뒤 source를
   * 읽어 SET 하므로, 같은 bucket에 대한 동시 피드백 복구는 직렬화된다. assistant 메시지 저장은
   * (메시지 insert + total_answers 증가)가 한 트랜잭션이고 그 증가가 이 bucket 행 잠금을
   * 기다리므로, 미커밋 메시지가 재계산에 이중 반영되지 않는다.
   *
   * total_tokens / total_requests 는 변경하지 않으며, 절대값 SET이라 재실행에도 멱등하다.
   */
  private async reconcileAnswerBucketFromSource(
    executor: UsageDbExecutor,
    bucket: { widgetKeyId: string; date: string; domain: string },
  ): Promise<void> {
    // 잠글 대상 행을 확보(없으면 0/0으로 생성; CHECK 만족).
    await executor
      .insert(usageDaily)
      .values({
        widgetKeyId: bucket.widgetKeyId,
        date: bucket.date,
        domain: bucket.domain,
        totalAnswers: 0,
        badAnswers: 0,
      })
      .onConflictDoNothing();

    // 같은 bucket에 대한 동시 복구를 직렬화한다.
    await executor
      .select({ id: usageDaily.id })
      .from(usageDaily)
      .where(
        and(
          eq(usageDaily.widgetKeyId, bucket.widgetKeyId),
          eq(usageDaily.date, bucket.date),
          eq(usageDaily.domain, bucket.domain),
        ),
      )
      .for('update');

    const dayStart = new Date(`${bucket.date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    // 해당 위젯·날짜의 assistant 답변을 읽어, domain은 앱과 동일한 getSourceFromPageUrl로 필터.
    const rows = await executor
      .select({
        pageUrl: sessions.pageUrl,
        rating: messageFeedbacks.rating,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .leftJoin(messageFeedbacks, eq(messageFeedbacks.messageId, messages.id))
      .where(
        and(
          eq(messages.role, 'assistant'),
          eq(sessions.widgetKeyId, bucket.widgetKeyId),
          gte(messages.createdAt, dayStart),
          lt(messages.createdAt, dayEnd),
        ),
      );

    let totalAnswers = 0;
    let badAnswers = 0;
    for (const row of rows) {
      if (getSourceFromPageUrl(row.pageUrl) !== bucket.domain) {
        continue;
      }
      totalAnswers += 1;
      if (row.rating === 'BAD') {
        badAnswers += 1;
      }
    }

    await executor
      .update(usageDaily)
      .set({ totalAnswers, badAnswers })
      .where(
        and(
          eq(usageDaily.widgetKeyId, bucket.widgetKeyId),
          eq(usageDaily.date, bucket.date),
          eq(usageDaily.domain, bucket.domain),
        ),
      );
  }

  /**
   * Admin 소유 또는 협업자로 접근 가능한 위젯 키별 사용량 통계 조회
   */
  async getWidgetKeyStats(
    adminUuid: string,
    options: GetWidgetKeyUsageOptions = {},
  ): Promise<WidgetKeyStatsDto[]> {
    const end = options.endDate ? new Date(options.endDate) : new Date();
    const start = options.startDate
      ? new Date(options.startDate)
      : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    // 소유 키 ID 목록
    const ownedKeys = await this.db
      .select({ id: widgetKeys.id })
      .from(widgetKeys)
      .where(
        and(
          eq(widgetKeys.createdByIdpUuid, adminUuid),
          ne(widgetKeys.status, 'REVOKED'),
        ),
      );

    // 협업자로 접근 가능한 키 ID 목록 (ACCEPTED, invitee_idp_uuid 매칭)
    const sharedKeyRows = await this.db
      .select({
        widgetKeyId: widgetKeyCollaborators.widgetKeyId,
      })
      .from(widgetKeyCollaborators)
      .innerJoin(
        widgetKeys,
        eq(widgetKeyCollaborators.widgetKeyId, widgetKeys.id),
      )
      .where(
        and(
          eq(widgetKeyCollaborators.inviteeIdpUuid, adminUuid),
          eq(widgetKeyCollaborators.status, 'ACCEPTED'),
          ne(widgetKeys.status, 'REVOKED'),
        ),
      );

    const accessibleKeyIds = [
      ...new Set([
        ...ownedKeys.map((k) => k.id),
        ...sharedKeyRows.map((r) => r.widgetKeyId),
      ]),
    ];

    if (accessibleKeyIds.length === 0) {
      return [];
    }

    const keyConditions = [inArray(widgetKeys.id, accessibleKeyIds)];
    if (options.widgetKeyId) {
      if (!accessibleKeyIds.includes(options.widgetKeyId)) {
        return [];
      }
      keyConditions.push(eq(widgetKeys.id, options.widgetKeyId));
    }

    const keys = await this.db
      .select({
        id: widgetKeys.id,
        name: widgetKeys.name,
        secretKey: widgetKeys.secretKey,
      })
      .from(widgetKeys)
      .where(and(...keyConditions));

    if (keys.length === 0) {
      return [];
    }

    const keyIds = keys.map((k) => k.id);
    const usageConditions = [
      inArray(usageDaily.widgetKeyId, keyIds),
      gte(usageDaily.date, startStr),
      lte(usageDaily.date, endStr),
    ];
    if (options.domain) {
      usageConditions.push(eq(usageDaily.domain, options.domain));
    }

    // 토큰·요청뿐 아니라 답변/BAD 답변 집계도 usage_daily 한 테이블에서 읽는다.
    // (messages / sessions / message_feedbacks raw 스캔 없음)
    const rows = await this.db
      .select({
        widgetKeyId: usageDaily.widgetKeyId,
        date: usageDaily.date,
        domain: usageDaily.domain,
        totalTokens: usageDaily.totalTokens,
        totalRequests: usageDaily.totalRequests,
        totalAnswers: usageDaily.totalAnswers,
        badAnswers: usageDaily.badAnswers,
      })
      .from(usageDaily)
      .where(and(...usageConditions));

    const byKey = new Map<
      string,
      {
        tokens: number;
        requests: number;
        answers: number;
        badAnswers: number;
        byDate: Map<string, { tokens: number; requests: number }>;
        byDomain: Map<string, { tokens: number; requests: number }>;
      }
    >();

    for (const k of keys) {
      byKey.set(k.id, {
        tokens: 0,
        requests: 0,
        answers: 0,
        badAnswers: 0,
        byDate: new Map(),
        byDomain: new Map(),
      });
    }

    for (const r of rows) {
      const agg = byKey.get(r.widgetKeyId)!;
      agg.tokens += r.totalTokens;
      agg.requests += r.totalRequests;
      agg.answers += r.totalAnswers;
      agg.badAnswers += r.badAnswers;

      const dateEntry = agg.byDate.get(r.date) ?? { tokens: 0, requests: 0 };
      dateEntry.tokens += r.totalTokens;
      dateEntry.requests += r.totalRequests;
      agg.byDate.set(r.date, dateEntry);

      const domainEntry = agg.byDomain.get(r.domain) ?? {
        tokens: 0,
        requests: 0,
      };
      domainEntry.tokens += r.totalTokens;
      domainEntry.requests += r.totalRequests;
      agg.byDomain.set(r.domain, domainEntry);
    }

    const result: WidgetKeyStatsDto[] = [];
    for (const k of keys) {
      const agg = byKey.get(k.id)!;
      const usageData: UsageDataDto[] = Array.from(agg.byDate.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, { tokens, requests }]) => ({
          date,
          tokens,
          requests,
        }));
      const domainStats: DomainStatDto[] = Array.from(
        agg.byDomain.entries(),
      ).map(([domain, { tokens, requests }]) => ({
        domain,
        tokens,
        requests,
      }));
      result.push({
        widgetKeyId: k.id,
        widgetKeyName: k.name,
        widgetKey: maskWidgetKey(k.secretKey),
        totalTokens: agg.tokens,
        totalRequests: agg.requests,
        resolutionRate: calculateResolutionRate(agg.answers, agg.badAnswers),
        usageData,
        domainStats,
      });
    }

    return result;
  }
}
