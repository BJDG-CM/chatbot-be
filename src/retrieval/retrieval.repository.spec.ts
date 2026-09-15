import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isExpiredAt } from './retrieval.repository';

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
