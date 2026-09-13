import { describe, expect, it } from '@jest/globals';
import {
  extractExactSignals,
  extractQuerySignals,
  matchExactSignals,
  normalizeForMatch,
  normalizeQuery,
  stripKoreanParticle,
} from './query-signals';

const signalValues = (question: string) =>
  extractExactSignals(normalizeQuery(question)).map((signal) => signal.value);

const signalKinds = (question: string) =>
  extractExactSignals(normalizeQuery(question)).map((signal) => signal.kind);

describe('normalizeQuery', () => {
  it('collapses whitespace and applies NFKC', () => {
    expect(normalizeQuery('  ＥＣ2205   선수과목  ')).toBe('EC2205 선수과목');
  });
});

describe('normalizeForMatch', () => {
  it('ignores case and whitespace so "9월 18일" matches "9월18일"', () => {
    expect(normalizeForMatch('9월 18일')).toBe(normalizeForMatch('9월18일'));
    expect(normalizeForMatch('Dean’s List')).toBe(
      normalizeForMatch('dean’slist'),
    );
  });
});

describe('extractExactSignals', () => {
  it('extracts course codes and normalizes their case and spacing', () => {
    expect(signalValues('ec 2205 선수과목 알려줘')).toContain('EC2205');
    expect(signalKinds('EC2205 선수과목 알려줘')).toContain('courseCode');
  });

  it('does not split a course code into a bare number or an abbreviation', () => {
    // "EC2205"에는 단어 경계가 없으므로 "2205"나 "EC"가 따로 잡히면 안 됩니다.
    expect(signalValues('EC2205 선수과목')).toEqual(['EC2205']);
  });

  it('extracts years and semesters', () => {
    const values = signalValues('2026학년도 2학기 수강신청 일정');
    expect(values).toContain('2026');
    expect(values).toContain('2학기');
  });

  it('does not read a semester out of 계절학기', () => {
    expect(signalValues('2026 하계 계절학기 일정')).toEqual(['2026']);
  });

  it('extracts Korean dates together with the bare month', () => {
    const values = signalValues('9월 18일에 무슨 행사 있어?');
    expect(values).toContain('9월 18일');
    expect(values).toContain('9월');
  });

  it('extracts ISO dates', () => {
    expect(signalValues('2026-03-02 개강일')).toContain('2026-03-02');
  });

  it('extracts uppercase abbreviations', () => {
    expect(signalValues('GIFT 학위연계과정 안내')).toContain('GIFT');
  });

  it('extracts quoted phrases verbatim', () => {
    expect(signalValues('"기초공학수학 II" 교재 알려줘')).toContain(
      '기초공학수학 II',
    );
  });

  it('extracts measures such as 학점', () => {
    expect(signalValues('졸업하려면 130학점 필요해?')).toContain('130학점');
  });

  it('returns nothing for a query with no discriminative token', () => {
    expect(signalValues('장학금 신청 방법 알려줘')).toEqual([]);
  });
});

describe('stripKoreanParticle', () => {
  it('strips a trailing particle', () => {
    expect(stripKoreanParticle('졸업요건은')).toBe('졸업요건');
    expect(stripKoreanParticle('수강신청에서')).toBe('수강신청');
  });

  it('prefers the longest particle so 에서는 is not read as 는', () => {
    expect(stripKoreanParticle('학사편람에서는')).toBe('학사편람');
  });

  it('leaves short tokens alone', () => {
    expect(stripKoreanParticle('강의')).toBe('강의');
    expect(stripKoreanParticle('학과')).toBe('학과');
  });

  it('never strips down below two characters', () => {
    expect(stripKoreanParticle('회의의')).toBe('회의');
  });
});

describe('extractQuerySignals', () => {
  it('puts exact signals in front of ordinary terms', () => {
    const { terms } = extractQuerySignals('EC2205 선수과목 알려줘');
    expect(terms[0]).toBe('ec2205');
    expect(terms).toContain('선수과목');
  });

  it('drops question filler words', () => {
    const { terms } = extractQuerySignals('장학금에 대해 알려줘');
    expect(terms).toContain('장학금');
    expect(terms).not.toContain('알려줘');
    expect(terms).not.toContain('대해');
  });

  it('keeps both the original token and its particle-stripped form', () => {
    const { terms } = extractQuerySignals('졸업요건은 무엇인가요');
    expect(terms).toContain('졸업요건은');
    expect(terms).toContain('졸업요건');
  });

  it('returns empty signals for an empty question', () => {
    expect(extractQuerySignals('   ')).toEqual({
      normalized: '',
      terms: [],
      exactSignals: [],
    });
  });

  it('caps the number of search terms so the SQL stays bounded', () => {
    const question = Array.from(
      { length: 40 },
      (_, index) => `검색어${index}번항목`,
    ).join(' ');
    expect(extractQuerySignals(question).terms.length).toBeLessThanOrEqual(12);
  });
});

describe('matchExactSignals', () => {
  const signals = extractExactSignals('EC2205 2026 9월 18일');

  it('matches ignoring case and whitespace', () => {
    const matched = matchExactSignals('ec 2205 강의계획서', signals).map(
      (signal) => signal.value,
    );
    expect(matched).toContain('EC2205');
  });

  it('matches a date written without a space', () => {
    const matched = matchExactSignals('행사일: 9월18일', signals).map(
      (signal) => signal.value,
    );
    expect(matched).toContain('9월 18일');
  });

  it('returns nothing for null text or no signals', () => {
    expect(matchExactSignals(null, signals)).toEqual([]);
    expect(matchExactSignals('EC2205', [])).toEqual([]);
  });
});
