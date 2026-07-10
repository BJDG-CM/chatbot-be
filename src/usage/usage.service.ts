import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DB_CONNECTION,
  type Database,
  sessions,
  usageDaily,
  widgetKeys,
  widgetKeyCollaborators,
} from '../db';
import { eq, sql, and, inArray, gte, lte, ne } from 'drizzle-orm';
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
 * - 없음/GOOD → BAD: +1
 * - BAD → 없음/GOOD: -1
 * - 그 외(상태 불변, GOOD↔없음): 0
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
   * delta가 0이면 아무 것도 하지 않는다.
   * 피드백 upsert와 같은 트랜잭션에서 호출해야 하며, 대상 행은 GREATEST/LEAST로
   * 클램프하여 동시성 상황에서도 0 <= bad_answers <= total_answers 불변식을 유지한다.
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

    await executor
      .insert(usageDaily)
      .values({
        widgetKeyId: params.widgetKeyId,
        date: dateStr,
        domain,
        // 정상 흐름에서는 답변 저장 시 total_answers 행이 이미 존재하므로 이 insert
        // 경로는 도달하지 않는다. 불변식(bad_answers <= total_answers) 보호를 위해 0으로 둔다.
        badAnswers: 0,
      })
      .onConflictDoUpdate({
        target: [usageDaily.widgetKeyId, usageDaily.date, usageDaily.domain],
        set: {
          badAnswers: sql`least(${usageDaily.totalAnswers}, greatest(0, ${usageDaily.badAnswers} + ${params.delta}))`,
        },
      });
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
