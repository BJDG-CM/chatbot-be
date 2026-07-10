import { readFileSync } from 'fs';
import { join } from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  aggregateUsageAnswerRows,
  makeUsageBucketKey,
  parseLockTimeoutMs,
  runBackfill,
  type UsageAnswerRow,
} from './usage-backfill';
import { type Database } from '../db';

const dialect = new PgDialect();

describe('parseLockTimeoutMs', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['negative', -1000],
    ['a decimal below 1ms that truncates to 0', 0.4],
    ['empty string', ''],
    ['blank string', '   '],
    ['non-numeric string', 'abc'],
  ] as const)('rejects %s', (_label, value) => {
    expect(() => parseLockTimeoutMs(value)).toThrow();
  });

  it('accepts a valid positive integer', () => {
    expect(parseLockTimeoutMs(30000)).toBe(30000);
  });

  it('accepts a numeric string', () => {
    expect(parseLockTimeoutMs('5000')).toBe(5000);
  });

  it('truncates a valid decimal to an integer', () => {
    expect(parseLockTimeoutMs(1500.7)).toBe(1500);
  });

  it('includes the source name in the error message', () => {
    expect(() =>
      parseLockTimeoutMs('nope', 'BACKFILL_LOCK_TIMEOUT_MS'),
    ).toThrow(/BACKFILL_LOCK_TIMEOUT_MS/);
  });
});

describe('makeUsageBucketKey', () => {
  it('serializes deterministically without control characters', () => {
    const key = makeUsageBucketKey('wk-1', '2026-07-01', 'www.example.com');
    expect(key).toBe('["wk-1","2026-07-01","www.example.com"]');
    const hasControlChar = [...key].some((c) => c.charCodeAt(0) < 32);
    expect(hasControlChar).toBe(false);
  });

  it('does not collide across boundary-ambiguous values', () => {
    // 구분자를 순진하게 쓰면 충돌할 수 있는 조합도 분리되어야 한다.
    const a = makeUsageBucketKey('wk', '2026-07-01', 'a b');
    const b = makeUsageBucketKey('wk 2026-07-01', 'a', 'b');
    expect(a).not.toBe(b);
  });
});

describe('aggregateUsageAnswerRows', () => {
  const base: Omit<UsageAnswerRow, 'rating'> = {
    widgetKeyId: 'wk-1',
    pageUrl: 'https://www.example.com/a',
    createdAt: new Date('2026-07-01T05:00:00.000Z'),
  };

  it('merges the same widget/date/domain into one bucket', () => {
    const buckets = aggregateUsageAnswerRows([
      { ...base, rating: null },
      { ...base, rating: 'GOOD' },
      { ...base, rating: 'BAD' },
    ]);

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      widgetKeyId: 'wk-1',
      date: '2026-07-01',
      domain: 'www.example.com',
      totalAnswers: 3,
      // BAD만 집계, GOOD/none은 제외
      badAnswers: 1,
    });
  });

  it('separates different domains', () => {
    const buckets = aggregateUsageAnswerRows([
      { ...base, rating: 'BAD' },
      {
        ...base,
        pageUrl: 'https://other.example.org/x',
        rating: 'BAD',
      },
    ]);

    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => b.domain).sort()).toEqual([
      'other.example.org',
      'www.example.com',
    ]);
  });

  it('parses web and app: page urls the same way as getSourceFromPageUrl', () => {
    const buckets = aggregateUsageAnswerRows([
      { ...base, pageUrl: 'https://www.example.com/deep/path', rating: null },
      { ...base, pageUrl: 'app:com.company.myapp', rating: 'BAD' },
    ]);

    const domains = buckets.map((b) => b.domain).sort();
    expect(domains).toEqual(['com.company.myapp', 'www.example.com']);
  });

  it('buckets by the UTC date of the answer creation time', () => {
    const buckets = aggregateUsageAnswerRows([
      {
        ...base,
        createdAt: new Date('2026-07-01T23:30:00.000Z'),
        rating: null,
      },
      {
        ...base,
        createdAt: new Date('2026-07-02T00:30:00.000Z'),
        rating: null,
      },
    ]);

    expect(buckets.map((b) => b.date).sort()).toEqual([
      '2026-07-01',
      '2026-07-02',
    ]);
  });
});

/**
 * runBackfill의 트랜잭션·잠금 순서와 upsert 페이로드를 캡처하는 fake.
 */
class FakeBackfillInsert {
  valuesPayload: Record<string, unknown> | undefined;

  constructor(private readonly tx: FakeBackfillTx) {}

  values(payload: Record<string, unknown>): this {
    this.valuesPayload = payload;
    return this;
  }

  onConflictDoUpdate(config: { set: Record<string, unknown> }): Promise<void> {
    this.tx.ops.push('insert');
    this.tx.upserts.push({
      values: this.valuesPayload ?? {},
      set: config.set,
    });
    return Promise.resolve();
  }
}

class FakeBackfillSelect implements PromiseLike<unknown[]> {
  constructor(private readonly rows: unknown[]) {}
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
  then<TResult1 = unknown[], TResult2 = never>(
    onfulfilled?:
      | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.rows).then(onfulfilled, onrejected);
  }
}

class FakeBackfillTx {
  readonly ops: string[] = [];
  readonly executed: string[] = [];
  readonly upserts: Array<{
    values: Record<string, unknown>;
    set: Record<string, unknown>;
  }> = [];

  constructor(private readonly rows: unknown[]) {}

  execute(query: SQL): Promise<void> {
    this.ops.push('execute');
    // sql`` / sql.raw 모두 SQL이므로 렌더링해서 텍스트로 기록.
    this.executed.push(dialect.sqlToQuery(query).sql);
    return Promise.resolve();
  }

  select(): FakeBackfillSelect {
    this.ops.push('select');
    return new FakeBackfillSelect(this.rows);
  }

  insert(): FakeBackfillInsert {
    return new FakeBackfillInsert(this);
  }
}

class FakeBackfillDb {
  tx: FakeBackfillTx;
  constructor(rows: unknown[]) {
    this.tx = new FakeBackfillTx(rows);
  }
  transaction<T>(callback: (tx: FakeBackfillTx) => Promise<T>): Promise<T> {
    return callback(this.tx);
  }
}

describe('runBackfill', () => {
  const rows: UsageAnswerRow[] = [
    {
      widgetKeyId: 'wk-1',
      pageUrl: 'https://www.example.com/a',
      createdAt: new Date('2026-07-01T05:00:00.000Z'),
      rating: 'BAD',
    },
    {
      widgetKeyId: 'wk-1',
      pageUrl: 'https://www.example.com/a',
      createdAt: new Date('2026-07-01T06:00:00.000Z'),
      rating: null,
    },
  ];

  it('locks tables before reading, then upserts inside one transaction', async () => {
    const db = new FakeBackfillDb(rows);

    const result = await runBackfill(db as unknown as Database, {
      logger: () => undefined,
    });

    // 순서: SET LOCAL / LOCK (execute) → select → insert(upsert)
    expect(db.tx.ops).toEqual(['execute', 'execute', 'select', 'insert']);
    expect(db.tx.executed[0].toLowerCase()).toContain('lock_timeout');
    expect(db.tx.executed[1]).toContain('LOCK TABLE');
    expect(db.tx.executed[1]).toContain('SHARE ROW EXCLUSIVE MODE');

    expect(result).toEqual({ processed: 2, applied: 1 });
  });

  it('sets absolute total/bad answers and never touches token/request columns', async () => {
    const db = new FakeBackfillDb(rows);

    await runBackfill(db as unknown as Database, { logger: () => undefined });

    expect(db.tx.upserts).toHaveLength(1);
    const { values, set } = db.tx.upserts[0];
    expect(values).toMatchObject({
      widgetKeyId: 'wk-1',
      date: '2026-07-01',
      domain: 'www.example.com',
      totalAnswers: 2,
      badAnswers: 1,
    });
    // 절대값 SET (멱등), tokens/requests 는 set 대상이 아님
    expect(set).toEqual({ totalAnswers: 2, badAnswers: 1 });
    expect(set).not.toHaveProperty('totalTokens');
    expect(set).not.toHaveProperty('totalRequests');
  });
});

describe('backfill script source hygiene', () => {
  it.each(['usage-backfill.ts', 'backfill-usage-answers.ts'])(
    '%s contains no NUL/control characters',
    (file) => {
      const buffer = readFileSync(join(__dirname, file));
      const hasControl = buffer.some(
        (byte) => byte < 9 || (byte > 13 && byte < 32),
      );
      expect(hasControl).toBe(false);
    },
  );
});
