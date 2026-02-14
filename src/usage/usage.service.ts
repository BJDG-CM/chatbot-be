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
import { extractDomain } from '../common/utils/domain-validator.util';
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
        origin: sessions.origin,
        pageUrl: sessions.pageUrl,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);

    if (!session) {
      this.logger.warn(`Session not found for recordUsage: ${sessionId}`);
      return;
    }

    const rawForDomain = session.origin ?? session.pageUrl;
    const domain = extractDomain(rawForDomain) || 'unknown';

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

    const keyMap = new Map(keys.map((k) => [k.id, k]));
    const byKey = new Map<
      string,
      {
        tokens: number;
        requests: number;
        byDate: Map<string, { tokens: number; requests: number }>;
        byDomain: Map<string, { tokens: number; requests: number }>;
      }
    >();

    for (const k of keys) {
      byKey.set(k.id, {
        tokens: 0,
        requests: 0,
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
        usageData,
        domainStats,
      });
    }

    return result;
  }
}
