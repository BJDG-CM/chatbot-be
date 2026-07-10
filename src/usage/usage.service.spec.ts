import {
  UsageService,
  calculateResolutionRate,
  computeBadAnswerDelta,
} from './usage.service';
import { type Database, messageFeedbacks, messages, usageDaily } from '../db';

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
    ['none', null, 'GOOD', 0],
    ['none', null, 'BAD', 1],
    ['good', 'GOOD', 'BAD', 1],
    ['bad', 'BAD', 'GOOD', -1],
    ['good', 'GOOD', 'GOOD', 0],
    ['bad', 'BAD', 'BAD', 0],
  ] as const)(
    '%s -> %s yields delta %d',
    (_label, previous, next, expected) => {
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

describe('UsageService.applyBadAnswerDelta', () => {
  const service = new UsageService({} as unknown as Database);

  it('attributes the delta to the answer creation date, not the feedback date', async () => {
    const executor = new FakeExecutor();

    await service.applyBadAnswerDelta(executor as never, {
      widgetKeyId: 'widget-key-1',
      pageUrl: 'https://www.example.com/help',
      createdAt: new Date('2026-07-01T23:30:00.000Z'),
      delta: 1,
    });

    expect(executor.inserts).toHaveLength(1);
    expect(executor.inserts[0].values).toMatchObject({
      widgetKeyId: 'widget-key-1',
      date: '2026-07-01',
      domain: 'www.example.com',
    });
  });

  it('parses app: page urls with the same helper as usage recording', async () => {
    const executor = new FakeExecutor();

    await service.applyBadAnswerDelta(executor as never, {
      widgetKeyId: 'widget-key-1',
      pageUrl: 'app:com.company.myapp',
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
      delta: -1,
    });

    expect(executor.inserts[0].values).toMatchObject({
      domain: 'com.company.myapp',
      date: '2026-07-05',
    });
  });

  it('does nothing when the delta is zero', async () => {
    const executor = new FakeExecutor();

    await service.applyBadAnswerDelta(executor as never, {
      widgetKeyId: 'widget-key-1',
      pageUrl: 'https://www.example.com',
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
      delta: 0,
    });

    expect(executor.inserts).toHaveLength(0);
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
