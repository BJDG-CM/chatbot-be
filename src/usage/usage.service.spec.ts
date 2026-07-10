import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  UsageService,
  calculateResolutionRate,
  computeBadAnswerDelta,
} from './usage.service';
import { type Database, messageFeedbacks, messages, usageDaily } from '../db';

const dialect = new PgDialect();
const render = (query: SQL): { sql: string; params: unknown[] } => {
  const { sql, params } = dialect.sqlToQuery(query);
  return { sql, params };
};

describe('calculateResolutionRate', () => {
  it('returns 0 when no answers were generated', () => {
    expect(calculateResolutionRate(0, 0)).toBe(0);
  });

  it('returns 100 when none of the answers have BAD feedback', () => {
    expect(calculateResolutionRate(5, 0)).toBe(100);
  });

  it('calculates the BAD feedback ratio against all generated answers', () => {
    expect(calculateResolutionRate(3, 1)).toBe(66.67);
  });
});

describe('computeBadAnswerDelta', () => {
  it.each([
    {
      label: 'none -> GOOD',
      previous: null,
      next: 'GOOD',
      expected: 0,
    },
    {
      label: 'none -> BAD',
      previous: null,
      next: 'BAD',
      expected: 1,
    },
    {
      label: 'GOOD -> BAD',
      previous: 'GOOD',
      next: 'BAD',
      expected: 1,
    },
    {
      label: 'BAD -> GOOD',
      previous: 'BAD',
      next: 'GOOD',
      expected: -1,
    },
    {
      label: 'GOOD -> GOOD',
      previous: 'GOOD',
      next: 'GOOD',
      expected: 0,
    },
    {
      label: 'BAD -> BAD',
      previous: 'BAD',
      next: 'BAD',
      expected: 0,
    },
  ] as const)(
    '$label yields delta $expected',
    ({ previous, next, expected }) => {
      expect(computeBadAnswerDelta(previous, next)).toBe(expected);
    },
  );
});
/**
 * usage_daily 쓰기(insert ... on conflict do update)를 캡처하는 fake executor.
 */
class FakeInsert {
  valuesPayload: Record<string, unknown> | undefined;

  constructor(private readonly store: FakeExecutor) {}

  values(payload: Record<string, unknown>): this {
    this.valuesPayload = payload;
    return this;
  }

  onConflictDoUpdate(config: unknown): Promise<void> {
    this.store.inserts.push({
      values: this.valuesPayload ?? {},
      config,
    });
    return Promise.resolve();
  }
}

class FakeExecutor {
  readonly inserts: Array<{
    values: Record<string, unknown>;
    config: unknown;
  }> = [];

  insert(_table: unknown): FakeInsert {
    return new FakeInsert(this);
  }
}

describe('UsageService.incrementTotalAnswers', () => {
  const service = new UsageService({} as unknown as Database);

  it('increments total_answers on the answer creation date and parsed domain', async () => {
    const executor = new FakeExecutor();

    await service.incrementTotalAnswers(executor as never, {
      widgetKeyId: 'widget-key-1',
      pageUrl: 'https://www.example.com/products/1',
      createdAt: new Date('2026-07-01T05:00:00.000Z'),
    });

    expect(executor.inserts).toHaveLength(1);
    expect(executor.inserts[0].values).toMatchObject({
      widgetKeyId: 'widget-key-1',
      date: '2026-07-01',
      domain: 'www.example.com',
      totalAnswers: 1,
    });
  });
});

interface SourceRow {
  pageUrl: string;
  rating: 'GOOD' | 'BAD' | null;
}

/**
 * applyBadAnswerDelta의 빠른 경로(가드 산술 UPDATE)와 복구 경로(placeholder insert +
 * FOR UPDATE 잠금 + source 재계산 + 절대값 SET)를 모두 캡처하는 fake.
 * `guardedRows`를 []로 두면 빠른 경로가 0행이 되어 복구 경로가 실행된다.
 */
class FakeAggUpdate {
  private setPayload: Record<string, unknown> = {};
  private wherePayload: SQL | undefined;
  private captured = false;

  constructor(private readonly store: FakeAggExecutor) {}

  set(payload: Record<string, unknown>): this {
    this.setPayload = payload;
    return this;
  }

  where(condition: SQL): this {
    this.wherePayload = condition;
    return this;
  }

  private capture(hadReturning: boolean): void {
    if (this.captured) return;
    this.captured = true;
    this.store.updates.push({
      set: this.setPayload,
      where: this.wherePayload,
      hadReturning,
    });
  }

  returning(_columns: unknown): Promise<unknown[]> {
    this.capture(true);
    if (this.store.failError) {
      return Promise.reject(this.store.failError);
    }
    return Promise.resolve(this.store.guardedRows);
  }

  // 복구 경로의 절대값 SET은 returning 없이 await 된다(thenable).
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.capture(false);
    return Promise.resolve(undefined as unknown).then(onfulfilled, onrejected);
  }
}

class FakeAggInsert {
  private vals: Record<string, unknown> = {};
  constructor(private readonly store: FakeAggExecutor) {}
  values(v: Record<string, unknown>): this {
    this.vals = v;
    return this;
  }
  onConflictDoNothing(): Promise<void> {
    this.store.inserts.push(this.vals);
    return Promise.resolve();
  }
}

class FakeAggSelect implements PromiseLike<SourceRow[]> {
  constructor(private readonly store: FakeAggExecutor) {}
  from(): this {
    return this;
  }
  innerJoin(): this {
    return this;
  }
  leftJoin(): this {
    return this;
  }
  where(): this {
    return this;
  }
  // FOR UPDATE 잠금 select은 .for()로 끝난다(await 대상).
  for(_strength: unknown, _config?: unknown): Promise<unknown[]> {
    this.store.forUpdateCalls += 1;
    return Promise.resolve([]);
  }
  // source scan select은 .then으로 await 된다.
  then<TResult1 = SourceRow[], TResult2 = never>(
    onfulfilled?:
      | ((value: SourceRow[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.store.sourceRows).then(onfulfilled, onrejected);
  }
}

class FakeAggExecutor {
  guardedRows: unknown[] = [{ id: 'usage-daily-1' }];
  sourceRows: SourceRow[] = [];
  failError: Error | null = null;
  forUpdateCalls = 0;
  readonly updates: Array<{
    set: Record<string, unknown>;
    where: SQL | undefined;
    hadReturning: boolean;
  }> = [];
  readonly inserts: Record<string, unknown>[] = [];

  update(_table: unknown): FakeAggUpdate {
    return new FakeAggUpdate(this);
  }
  insert(_table: unknown): FakeAggInsert {
    return new FakeAggInsert(this);
  }
  select(_columns: unknown): FakeAggSelect {
    return new FakeAggSelect(this);
  }
}

describe('UsageService.applyBadAnswerDelta', () => {
  const service = new UsageService({} as unknown as Database);

  it('fast path: applies +1 as a guarded SQL arithmetic update on bad_answers', async () => {
    const executor = new FakeAggExecutor();

    await service.applyBadAnswerDelta(executor as never, {
      widgetKeyId: 'widget-key-1',
      pageUrl: 'https://www.example.com/help',
      // 피드백 등록일이 아니라 답변 생성일(과거)에 귀속되어야 한다.
      createdAt: new Date('2026-07-01T23:30:00.000Z'),
      delta: 1,
    });

    // 빠른 경로만 실행(복구 경로 미실행).
    expect(executor.updates).toHaveLength(1);
    expect(executor.inserts).toHaveLength(0);
    expect(executor.forUpdateCalls).toBe(0);

    const setSql = render(executor.updates[0].set.badAnswers as SQL);
    expect(setSql.sql).toContain('"bad_answers" + ');

    const whereSql = render(executor.updates[0].where as SQL);
    expect(whereSql.params).toContain('widget-key-1');
    expect(whereSql.params).toContain('2026-07-01');
    expect(whereSql.params).toContain('www.example.com');
    // 가드로 invariant를 지키므로 clamp(least/greatest)는 쓰지 않는다.
    expect(whereSql.sql.toLowerCase()).not.toContain('least');
    expect(whereSql.sql.toLowerCase()).not.toContain('greatest');
    expect(setSql.sql.toLowerCase()).not.toContain('least');
  });

  it('fast path: applies -1 and parses app: page urls the same way', async () => {
    const executor = new FakeAggExecutor();

    await service.applyBadAnswerDelta(executor as never, {
      widgetKeyId: 'widget-key-1',
      pageUrl: 'app:com.company.myapp',
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
      delta: -1,
    });

    const whereSql = render(executor.updates[0].where as SQL);
    expect(whereSql.params).toContain('com.company.myapp');
    expect(whereSql.params).toContain('2026-07-05');
    expect(executor.forUpdateCalls).toBe(0);
  });

  it('does not run any DB write when the delta is zero', async () => {
    const executor = new FakeAggExecutor();

    await service.applyBadAnswerDelta(executor as never, {
      widgetKeyId: 'widget-key-1',
      pageUrl: 'https://www.example.com',
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
      delta: 0,
    });

    expect(executor.updates).toHaveLength(0);
    expect(executor.inserts).toHaveLength(0);
  });

  it('reconcile: GOOD -> BAD on a not-yet-backfilled answer recomputes the bucket from source', async () => {
    const executor = new FakeAggExecutor();
    executor.guardedRows = []; // 빠른 경로가 0행 → 복구 경로
    // source: 같은 bucket에 assistant 답변 3개, 그중 BAD 1개
    executor.sourceRows = [
      { pageUrl: 'https://www.example.com/a', rating: 'BAD' },
      { pageUrl: 'https://www.example.com/b', rating: 'GOOD' },
      { pageUrl: 'https://www.example.com/c', rating: null },
    ];

    await service.applyBadAnswerDelta(executor as never, {
      widgetKeyId: 'widget-key-1',
      pageUrl: 'https://www.example.com/a',
      createdAt: new Date('2026-07-01T05:00:00.000Z'),
      delta: 1,
    });

    // 복구 경로: placeholder insert → FOR UPDATE 잠금 → 절대값 SET
    expect(executor.inserts).toHaveLength(1);
    expect(executor.inserts[0]).toMatchObject({
      widgetKeyId: 'widget-key-1',
      date: '2026-07-01',
      domain: 'www.example.com',
      totalAnswers: 0,
      badAnswers: 0,
    });
    expect(executor.forUpdateCalls).toBe(1);

    // 마지막 update는 returning 없는 절대값 SET
    const reconcileSet = executor.updates[executor.updates.length - 1];
    expect(reconcileSet.hadReturning).toBe(false);
    expect(reconcileSet.set).toEqual({ totalAnswers: 3, badAnswers: 1 });
    // token/request 컬럼은 건드리지 않는다.
    expect(reconcileSet.set).not.toHaveProperty('totalTokens');
    expect(reconcileSet.set).not.toHaveProperty('totalRequests');
    // 불변식: bad <= total
    expect(reconcileSet.set.badAnswers as number).toBeLessThanOrEqual(
      reconcileSet.set.totalAnswers as number,
    );
  });

  it('reconcile: BAD -> GOOD on a not-yet-backfilled answer sets absolute counts from source', async () => {
    const executor = new FakeAggExecutor();
    executor.guardedRows = [];
    // BAD가 GOOD으로 바뀐 뒤의 source 상태: 답변 2개, BAD 0개
    executor.sourceRows = [
      { pageUrl: 'https://www.example.com/a', rating: 'GOOD' },
      { pageUrl: 'https://www.example.com/b', rating: null },
    ];

    await service.applyBadAnswerDelta(executor as never, {
      widgetKeyId: 'widget-key-1',
      pageUrl: 'https://www.example.com/a',
      createdAt: new Date('2026-07-01T05:00:00.000Z'),
      delta: -1,
    });

    const reconcileSet = executor.updates[executor.updates.length - 1];
    expect(reconcileSet.set).toEqual({ totalAnswers: 2, badAnswers: 0 });
  });

  it('reconcile: counts only answers whose domain matches the target bucket', async () => {
    const executor = new FakeAggExecutor();
    executor.guardedRows = [];
    executor.sourceRows = [
      { pageUrl: 'https://www.example.com/a', rating: 'BAD' },
      // 다른 domain → 집계에서 제외되어야 한다.
      { pageUrl: 'https://other.example.org/x', rating: 'BAD' },
    ];

    await service.applyBadAnswerDelta(executor as never, {
      widgetKeyId: 'widget-key-1',
      pageUrl: 'https://www.example.com/a',
      createdAt: new Date('2026-07-01T05:00:00.000Z'),
      delta: 1,
    });

    const reconcileSet = executor.updates[executor.updates.length - 1];
    expect(reconcileSet.set).toEqual({ totalAnswers: 1, badAnswers: 1 });
  });

  it('propagates aggregation update failures so the feedback transaction rolls back', async () => {
    const executor = new FakeAggExecutor();
    executor.failError = new Error('bad_answers check constraint violation');

    await expect(
      service.applyBadAnswerDelta(executor as never, {
        widgetKeyId: 'widget-key-1',
        pageUrl: 'https://www.example.com',
        createdAt: new Date('2026-07-05T00:00:00.000Z'),
        delta: 1,
      }),
    ).rejects.toThrow('bad_answers check constraint violation');
  });
});

/**
 * getWidgetKeyStats 조회 전용 fake db.
 * select().from(table) 순서대로 queue된 결과를 돌려주고, from()에 넘어온 테이블을 기록한다.
 */
class FakeSelect implements PromiseLike<unknown[]> {
  constructor(
    private readonly rows: unknown[],
    private readonly onFrom: (table: unknown) => void,
  ) {}

  from(table: unknown): this {
    this.onFrom(table);
    return this;
  }

  innerJoin(table: unknown, _condition: unknown): this {
    this.onFrom(table);
    return this;
  }

  leftJoin(table: unknown, _condition: unknown): this {
    this.onFrom(table);
    return this;
  }

  where(_condition: unknown): this {
    return this;
  }

  groupBy(_columns: unknown): this {
    return this;
  }

  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?:
      | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.rows).then(onfulfilled, onrejected);
  }
}

class FakeStatsDb {
  readonly fromTables: unknown[] = [];
  private readonly selectQueue: unknown[][] = [];

  queueSelect(rows: unknown[]): void {
    this.selectQueue.push(rows);
  }

  select(_selection?: unknown): FakeSelect {
    return new FakeSelect(this.selectQueue.shift() ?? [], (table) =>
      this.fromTables.push(table),
    );
  }
}

describe('UsageService.getWidgetKeyStats', () => {
  const adminUuid = 'admin-1';

  const setup = (
    usageRows: unknown[],
  ): { service: UsageService; db: FakeStatsDb } => {
    const db = new FakeStatsDb();
    db.queueSelect([{ id: 'widget-key-1' }]); // owned keys
    db.queueSelect([]); // shared keys
    db.queueSelect([
      { id: 'widget-key-1', name: 'Main', secretKey: 'wk_live_abcdef_xyz' },
    ]); // accessible keys
    db.queueSelect(usageRows); // usage_daily rows
    return {
      service: new UsageService(db as unknown as Database),
      db,
    };
  };

  it('derives resolutionRate from usage_daily total_answers/bad_answers only', async () => {
    const { service, db } = setup([
      {
        widgetKeyId: 'widget-key-1',
        date: '2026-07-01',
        domain: 'www.example.com',
        totalTokens: 100,
        totalRequests: 3,
        totalAnswers: 3,
        badAnswers: 1,
      },
      {
        widgetKeyId: 'widget-key-1',
        date: '2026-07-02',
        domain: 'www.example.com',
        totalTokens: 50,
        totalRequests: 2,
        totalAnswers: 2,
        badAnswers: 0,
      },
    ]);

    const [stats] = await service.getWidgetKeyStats(adminUuid, {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });

    expect(stats).toMatchObject({
      widgetKeyId: 'widget-key-1',
      totalTokens: 150,
      totalRequests: 5,
      // total_answers=5, bad_answers=1 -> (1 - 1/5) * 100 = 80
      resolutionRate: 80,
    });

    // messages / message_feedbacks 테이블은 조회하지 않는다.
    expect(db.fromTables).toContain(usageDaily);
    expect(db.fromTables).not.toContain(messages);
    expect(db.fromTables).not.toContain(messageFeedbacks);
  });

  it('returns resolutionRate 0 when there are no counted answers', async () => {
    const { service } = setup([
      {
        widgetKeyId: 'widget-key-1',
        date: '2026-07-01',
        domain: 'www.example.com',
        totalTokens: 100,
        totalRequests: 3,
        totalAnswers: 0,
        badAnswers: 0,
      },
    ]);

    const [stats] = await service.getWidgetKeyStats(adminUuid, {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });

    expect(stats.resolutionRate).toBe(0);
  });

  it('only aggregates usage_daily rows returned under the date/domain filter', async () => {
    // domain 필터가 적용된 usage_daily 행만 반환되면 resolutionRate도 그 행들로만 계산된다.
    const { service } = setup([
      {
        widgetKeyId: 'widget-key-1',
        date: '2026-07-01',
        domain: 'www.example.com',
        totalTokens: 10,
        totalRequests: 1,
        totalAnswers: 4,
        badAnswers: 1,
      },
    ]);

    const [stats] = await service.getWidgetKeyStats(adminUuid, {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      domain: 'www.example.com',
    });

    // total_answers=4, bad_answers=1 -> (1 - 1/4) * 100 = 75
    expect(stats.resolutionRate).toBe(75);
    expect(stats.domainStats).toEqual([
      { domain: 'www.example.com', tokens: 10, requests: 1 },
    ]);
  });
});
