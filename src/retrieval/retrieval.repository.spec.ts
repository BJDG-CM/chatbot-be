import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildLexicalScoreSql,
  isExpiredAt,
  toLikePattern,
} from './retrieval.repository';
import {
  LEXICAL_EXACT_TERM_MULTIPLIER,
  LEXICAL_FIELD_WEIGHTS,
} from './retrieval.constants';

const dialect = new PgDialect();
const render = (query: ReturnType<typeof buildLexicalScoreSql>) => ({
  score: dialect.sqlToQuery(query!.score),
  match: dialect.sqlToQuery(query!.match),
});

describe('isExpiredAt', () => {
  const now = new Date('2026-07-30T12:00:00.000Z');

  it('treats null as never expired', () => {
    expect(isExpiredAt(null, now)).toBe(false);
    expect(isExpiredAt(undefined, now)).toBe(false);
  });

  it('treats future expiresAt as not expired', () => {
    expect(isExpiredAt(new Date('2026-07-30T12:00:01.000Z'), now)).toBe(false);
  });

  it('treats expiresAt at or before now as expired', () => {
    expect(isExpiredAt(new Date('2026-07-30T12:00:00.000Z'), now)).toBe(true);
    expect(isExpiredAt(new Date('2026-07-30T11:59:59.000Z'), now)).toBe(true);
  });
});

describe('retrieval organization scope invariant', () => {
  it('keeps chatbot retrieval global and free of organization predicates', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'retrieval', 'retrieval.repository.ts'),
      'utf8',
    );
    expect(source).not.toContain('ownerOrganizationId');
    expect(source).not.toContain('documentOrganizationShares');
    expect(source).toContain("eq(documents.status, 'ready')");
    expect(source).toContain('eq(documents.isActive, true)');
    expect(source).toContain('notExpiredCondition()');
  });
});

describe('toLikePattern', () => {
  it('wraps the term in wildcards', () => {
    expect(toLikePattern('EC2205')).toBe('%EC2205%');
  });

  it('escapes LIKE wildcards so user input cannot widen the match', () => {
    expect(toLikePattern('100%_할인')).toBe('%100\\%\\_할인%');
    expect(toLikePattern('a\\b')).toBe('%a\\\\b%');
  });
});

describe('buildLexicalScoreSql', () => {
  it('returns null when there is nothing to search for', () => {
    expect(buildLexicalScoreSql([], [])).toBeNull();
  });

  it('binds every term as a parameter rather than inlining it', () => {
    const { score, match } = render(buildLexicalScoreSql(['장학금'], []));

    // 검색어는 항상 바인드 파라미터로 나가야 합니다(SQL 인젝션 방지).
    expect(score.params).toContain('%장학금%');
    expect(match.params).toContain('%장학금%');
    expect(score.sql).not.toContain('장학금');
  });

  it('scores the four metadata fields for an ordinary term', () => {
    const { score, match } = render(buildLexicalScoreSql(['장학금'], []));

    expect(score.sql).toContain('"documents"."title" ILIKE');
    expect(score.sql).toContain('"document_chunks"."path" ILIKE');
    expect(score.sql).toContain('"document_chunks"."description" ILIKE');
    expect(score.sql).toContain('"documents"."summary" ILIKE');
    // 일반 어휘는 본문을 훑지 않습니다.
    expect(score.sql).not.toContain('"document_chunks"."content"');
    expect(match.sql).not.toContain('"document_chunks"."content"');
    expect(score.params).toHaveLength(4);
  });

  it('scans the content column only for exact signals', () => {
    const { score, match } = render(
      buildLexicalScoreSql(['ec2205'], ['EC2205']),
    );

    expect(score.sql).toContain('"document_chunks"."content" ILIKE');
    expect(match.sql).toContain('"document_chunks"."content" ILIKE');
    // 메타데이터 4필드 + 본문 1필드
    expect(score.params).toHaveLength(5);
  });

  it('weights an exact signal above the same term as ordinary vocabulary', () => {
    const ordinary = render(buildLexicalScoreSql(['2026'], []));
    const exact = render(buildLexicalScoreSql(['2026'], ['2026']));

    expect(ordinary.score.sql).toContain(
      `THEN ${LEXICAL_FIELD_WEIGHTS.title} `,
    );
    expect(exact.score.sql).toContain(
      `THEN ${LEXICAL_FIELD_WEIGHTS.title * LEXICAL_EXACT_TERM_MULTIPLIER} `,
    );
  });

  it('ranks title and path above description and summary', () => {
    expect(LEXICAL_FIELD_WEIGHTS.title).toBeGreaterThan(
      LEXICAL_FIELD_WEIGHTS.description,
    );
    expect(LEXICAL_FIELD_WEIGHTS.path).toBeGreaterThan(
      LEXICAL_FIELD_WEIGHTS.summary,
    );
    expect(LEXICAL_FIELD_WEIGHTS.description).toBeGreaterThan(
      LEXICAL_FIELD_WEIGHTS.content,
    );
  });

  it('sums one CASE expression per term and field', () => {
    const { score } = render(buildLexicalScoreSql(['가', '나', '다'], []));
    expect(score.sql.match(/CASE WHEN/g)).toHaveLength(3 * 4);
    expect(score.sql).toContain(' + ');
  });

  it('ORs the match conditions so any single field hit qualifies', () => {
    const { match } = render(buildLexicalScoreSql(['가', '나'], []));
    expect(match.sql.match(/ or /g)).toHaveLength(2 * 4 - 1);
  });
});
