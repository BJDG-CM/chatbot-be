import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

describe('message feedback migration', () => {
  const migrationSql = readdirSync(join(process.cwd(), 'drizzle'))
    .filter((file) => file.endsWith('.sql'))
    .map((file) => readFileSync(join(process.cwd(), 'drizzle', file), 'utf8'))
    .join('\n');

  it('creates the GOOD/BAD rating enum', () => {
    expect(migrationSql).toContain(
      `CREATE TYPE "public"."message_feedback_rating" AS ENUM('GOOD', 'BAD')`,
    );
  });

  it('creates a feedback table linked to messages', () => {
    expect(migrationSql).toContain('CREATE TABLE "message_feedbacks"');
    expect(migrationSql).toContain('"message_id" uuid NOT NULL');
    expect(migrationSql).toContain(
      'FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade',
    );
  });

  it('enforces one current feedback row per message', () => {
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "message_feedbacks_message_id_unique"',
    );
  });
});
