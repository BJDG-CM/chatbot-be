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
import { eq, sql, and, inArray, gte, lte, lt, ne, count } from 'drizzle-orm';
import { getSourceFromPageUrl } from '../common/utils/domain-validator.util';
import {
  WidgetKeyStatsDto,
  UsageDataDto,
  DomainStatDto,
} from '../common/dto/widget-key-usage.dto';

/**
 * 채팅 완료 시 사용량을 usage_daily에 기록할 때 전달하는 값
 */
export interface RecordUsageInput {
  totalTokens: number;
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
    const startDateTime = new Date(`${startStr}T00:00:00.000Z`);
    const endExclusive = new Date(`${endStr}T00:00:00.000Z`);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

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

    const rows = await this.db
      .select({
        widgetKeyId: usageDaily.widgetKeyId,
        date: usageDaily.date,
        domain: usageDaily.domain,
        totalTokens: usageDaily.totalTokens,
        totalRequests: usageDaily.totalRequests,
      })
      .from(usageDaily)
      .where(and(...usageConditions));

    const normalizedSessionSource = sql<string>`
      case
        when btrim(${sessions.pageUrl}) = '' then 'unknown'
        when btrim(${sessions.pageUrl}) like 'app:%' then coalesce(nullif(btrim(substring(btrim(${sessions.pageUrl}) from 5)), ''), 'unknown')
        when btrim(${sessions.pageUrl}) ~* '^[a-z][a-z0-9+.-]*://' then coalesce(nullif(split_part(regexp_replace(btrim(${sessions.pageUrl}), '^[a-z][a-z0-9+.-]*://([^/\\?#]+).*$', '\\1', 'i'), ':', 1), ''), 'unknown')
        else coalesce(nullif(regexp_replace(btrim(${sessions.pageUrl}), '^(?:https?://)?([^/\\?#]+).*$', '\\1', 'i'), ''), 'unknown')
      end
    `;
    const answerConditions = [
      inArray(sessions.widgetKeyId, keyIds),
      eq(messages.role, 'assistant'),
      gte(messages.createdAt, startDateTime),
      lt(messages.createdAt, endExclusive),
    ];
    if (options.domain) {
      answerConditions.push(eq(normalizedSessionSource, options.domain));
    }

    const answerRows = await this.db
      .select({
        widgetKeyId: sessions.widgetKeyId,
        answers: count(messages.id),
        badAnswers: sql<number>`count(case when ${messageFeedbacks.rating} = 'BAD' then 1 end)`,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.sessionId, sessions.id))
      .leftJoin(messageFeedbacks, eq(messageFeedbacks.messageId, messages.id))
      .where(and(...answerConditions))
      .groupBy(sessions.widgetKeyId);

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

    for (const r of answerRows) {
      const agg = byKey.get(r.widgetKeyId);
      if (!agg) {
        continue;
      }

      agg.answers += Number(r.answers ?? 0);
      agg.badAnswers += Number(r.badAnswers ?? 0);
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
