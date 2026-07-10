import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

describe('usage_daily answer aggregation migration', () => {
  const migrationSql = readdirSync(join(process.cwd(), 'drizzle'))
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readFileSync(join(process.cwd(), 'drizzle', file), 'utf8'))
    .join('\n');

  it('adds total_answers and bad_answers columns with a zero default', () => {
    expect(migrationSql).toContain(
      'ADD COLUMN "total_answers" integer DEFAULT 0 NOT NULL',
    );
    expect(migrationSql).toContain(
      'ADD COLUMN "bad_answers" integer DEFAULT 0 NOT NULL',
    );
  });

  it('enforces the non-negative and bad<=total integrity constraints', () => {
    expect(migrationSql).toContain(
      '"usage_daily_total_answers_non_negative" CHECK ("usage_daily"."total_answers" >= 0)',
    );
    expect(migrationSql).toContain(
      '"usage_daily_bad_answers_non_negative" CHECK ("usage_daily"."bad_answers" >= 0)',
    );
    expect(migrationSql).toContain(
      '"usage_daily_bad_answers_lte_total" CHECK ("usage_daily"."bad_answers" <= "usage_daily"."total_answers")',
    );
  });
});
