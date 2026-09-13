/**
 * 질의에서 "결정적(lexical/exact) 신호"를 뽑아내는 순수 함수 모음.
 *
 * 벡터 임베딩은 문장 전체의 의미를 잘 잡지만, `EC2205`/`2026`/`2학기`/`9월 18일`처럼
 * 한 글자만 달라도 답이 완전히 달라지는 토큰은 거의 구분하지 못합니다.
 * 여기서 뽑은 신호를 lexical 검색과 exact 가점에 사용합니다.
 *
 * DB·NestJS에 의존하지 않으므로 단독으로 단위 테스트할 수 있습니다.
 */

/** exact 신호 종류. 로깅·디버깅에서 "왜 뽑혔는지" 설명하기 위해 유지합니다. */
export type ExactSignalKind =
  | 'quoted'
  | 'courseCode'
  | 'year'
  | 'semester'
  | 'date'
  | 'abbreviation'
  | 'measure'
  | 'number';

export type ExactSignal = {
  /** 매칭에 사용할 값(표시용 원문) */
  value: string;
  kind: ExactSignalKind;
};

export type QuerySignals = {
  /** 공백·유니코드 정규화된 질의 */
  normalized: string;
  /** lexical 검색에 사용할 검색어(소문자). exact 신호를 앞쪽에 배치합니다. */
  terms: string[];
  /** 고변별 exact 신호 */
  exactSignals: ExactSignal[];
};

/** SQL 크기와 계획 시간을 제한하기 위한 검색어 상한. */
const MAX_TERMS = 12;

/** 길이 기준으로 걸러낼 최소 토큰 길이 */
const MIN_KOREAN_TOKEN_LENGTH = 2;
const MIN_LATIN_TOKEN_LENGTH = 3;

/**
 * 조사. 긴 것부터 검사해야 "에서는"이 "는"으로 잘못 잘리지 않습니다.
 * 형태소 분석기를 붙이지 않고, 흔한 조사만 떼는 수준으로 유지합니다.
 */
const KOREAN_PARTICLES = [
  '으로는',
  '에서는',
  '에게는',
  '이라는',
  '라는',
  '이란',
  '에서',
  '에게',
  '으로',
  '부터',
  '까지',
  '한테',
  '에는',
  '에도',
  '보다',
  '처럼',
  '만큼',
  '이나',
  '은',
  '는',
  '이',
  '가',
  '을',
  '를',
  '의',
  '에',
  '와',
  '과',
  '도',
  '만',
  '로',
  '나',
  '랑',
];

/** 질문 상투어. 검색어로 쓰면 노이즈만 늘어납니다. */
const KOREAN_STOPWORDS = new Set([
  '알려줘',
  '알려주세요',
  '알려',
  '가르쳐',
  '뭐야',
  '무엇',
  '어떻게',
  '어떤',
  '언제',
  '어디',
  '누구',
  '얼마',
  '있나요',
  '있어',
  '있는',
  '있을',
  '하나요',
  '해줘',
  '주세요',
  '대해',
  '대한',
  '관련',
  '관하여',
  '궁금',
  '궁금해',
  '정보',
  '내용',
  '사항',
  '경우',
  '그리고',
  '하는',
  '되나요',
  '인가요',
  '입니까',
  '건가요',
  '싶어',
  '싶은',
]);

const LATIN_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'what',
  'when',
  'where',
  'how',
  'why',
  'who',
  'are',
  'was',
  'were',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'tell',
  'about',
  'please',
  'from',
  'into',
  'this',
  'that',
  'there',
  'here',
  'have',
  'has',
]);

/** 유니코드 호환 문자 정규화 + 공백 정리 */
export function normalizeQuery(question: string): string {
  return question.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** 매칭 비교용 정규화: 소문자 + 공백 제거. "9월 18일"과 "9월18일"을 같게 봅니다. */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/**
 * 흔한 조사를 한 번만 떼어냅니다.
 * "전공학과" → "전공학"처럼 과도하게 자를 수 있으므로, 호출부는 원형도 함께 보존합니다.
 */
export function stripKoreanParticle(token: string): string {
  if (token.length < 3) return token;
  for (const particle of KOREAN_PARTICLES) {
    if (token.length - particle.length < 2) continue;
    if (token.endsWith(particle)) {
      return token.slice(0, token.length - particle.length);
    }
  }
  return token;
}

function pushSignal(
  out: ExactSignal[],
  seen: Set<string>,
  value: string,
  kind: ExactSignalKind,
): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  const key = normalizeForMatch(trimmed);
  if (key.length === 0 || seen.has(key)) return;
  seen.add(key);
  out.push({ value: trimmed, kind });
}

/**
 * 질의에서 고변별 exact 신호를 추출합니다.
 * 규칙 순서 = 변별력이 높다고 판단한 순서이며, 먼저 잡힌 값이 우선합니다.
 */
export function extractExactSignals(normalized: string): ExactSignal[] {
  const signals: ExactSignal[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  /**
   * 과목코드가 차지한 문자 범위. 뒤에 오는 수량·숫자 규칙이 같은 자리를 다시
   * 해석하지 못하게 막습니다. 예: "EC2201 회로이론"에서 "2201 회"를 수량으로 읽는 경우.
   */
  const courseCodeRanges: Array<[number, number]> = [];
  const overlapsCourseCode = (start: number, end: number): boolean =>
    courseCodeRanges.some(([from, to]) => start < to && end > from);

  // 따옴표로 감싼 구절은 사용자가 직접 지정한 정확 일치 요구로 취급합니다.
  const quoted = /"([^"]{2,60})"|'([^']{2,60})'|「([^」]{2,60})」/g;
  while ((match = quoted.exec(normalized)) !== null) {
    pushSignal(signals, seen, match[1] ?? match[2] ?? match[3], 'quoted');
  }

  // 과목코드/식별자: EC2205, GS1001, EC 2205
  const courseCode = /\b([A-Za-z]{2,4})\s?(\d{3,4})\b/g;
  while ((match = courseCode.exec(normalized)) !== null) {
    courseCodeRanges.push([match.index, match.index + match[0].length]);
    pushSignal(
      signals,
      seen,
      `${match[1].toUpperCase()}${match[2]}`,
      'courseCode',
    );
  }

  // 연도: 2026, 2026년
  const year = /\b(?:19|20)\d{2}\b/g;
  while ((match = year.exec(normalized)) !== null) {
    pushSignal(signals, seen, match[0], 'year');
  }

  // 학기: 2학기, 1 학기, 12학기
  // 앞뒤 숫자 경계가 "12학기"에서 "2학기"만 떼어내는 오탐을 막습니다.
  // 한 자리로 제한하지 않는 것은 최장재학연한 규정처럼 "12학기 이내" 표현이 쓰이기 때문입니다.
  const semester = /(?<!\d)(\d{1,2})\s*학기(?!\d)/g;
  while ((match = semester.exec(normalized)) !== null) {
    pushSignal(signals, seen, `${match[1]}학기`, 'semester');
  }

  // 분기: 1~4만 존재하므로 범위를 제한해 오탐을 줄입니다.
  const quarter = /(?<!\d)([1-4])\s*분기(?!\d)/g;
  while ((match = quarter.exec(normalized)) !== null) {
    pushSignal(signals, seen, `${match[1]}분기`, 'semester');
  }

  // 날짜: 9월 18일 / 2026-03-02
  const koreanDate = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
  while ((match = koreanDate.exec(normalized)) !== null) {
    pushSignal(signals, seen, `${match[1]}월 ${match[2]}일`, 'date');
    // 문서 표기가 "9월"까지만인 경우도 잡기 위해 월 단독 신호를 함께 남깁니다.
    pushSignal(signals, seen, `${match[1]}월`, 'date');
  }
  const isoDate = /\b\d{4}-\d{1,2}-\d{1,2}\b/g;
  while ((match = isoDate.exec(normalized)) !== null) {
    pushSignal(signals, seen, match[0], 'date');
  }

  // 대문자 약어: GIST, GIFT, MOU
  // "EC 2201"처럼 과목코드가 띄어 쓰인 경우의 "EC"는 약어가 아니므로 제외합니다.
  const abbreviation = /\b[A-Z]{2,}\b/g;
  while ((match = abbreviation.exec(normalized)) !== null) {
    if (overlapsCourseCode(match.index, match.index + match[0].length)) {
      continue;
    }
    pushSignal(signals, seen, match[0], 'abbreviation');
  }

  // 수량: 130학점, 130 학점, 3시간, 3 시간
  const measure = /(?<!\d)(\d{1,4})\s*(학점|시간|주|회|명|원|점|단계|개)/g;
  while ((match = measure.exec(normalized)) !== null) {
    if (overlapsCourseCode(match.index, match.index + match[0].length)) {
      continue;
    }
    pushSignal(signals, seen, `${match[1]}${match[2]}`, 'measure');
  }

  // 남은 숫자(2자리 이상). 위 규칙에 걸리지 않은 식별자성 숫자를 담습니다.
  // 과목코드의 숫자 부분("EC 2201"의 2201)은 이미 더 강한 신호로 잡혔으므로 제외합니다.
  const bareNumber = /\b\d{2,}\b/g;
  while ((match = bareNumber.exec(normalized)) !== null) {
    if (overlapsCourseCode(match.index, match.index + match[0].length)) {
      continue;
    }
    pushSignal(signals, seen, match[0], 'number');
  }

  return signals;
}

/**
 * lexical 검색어 추출: exact 신호 + 한글/영문 내용어.
 * exact 신호를 앞쪽에 두어, MAX_TERMS로 잘릴 때 변별력 높은 항목이 살아남게 합니다.
 */
export function extractQuerySignals(question: string): QuerySignals {
  const normalized = normalizeQuery(question ?? '');
  if (normalized.length === 0) {
    return { normalized: '', terms: [], exactSignals: [] };
  }

  const exactSignals = extractExactSignals(normalized);

  const terms: string[] = [];
  const seenTerms = new Set<string>();
  const addTerm = (raw: string) => {
    const term = raw.trim().toLowerCase();
    if (term.length === 0 || seenTerms.has(term)) return;
    seenTerms.add(term);
    terms.push(term);
  };

  for (const signal of exactSignals) {
    addTerm(signal.value);
  }

  const tokens = normalized.match(/[가-힣]+|[A-Za-z][A-Za-z0-9]*/g) ?? [];
  // 긴 토큰이 대체로 더 변별력이 높아, 상한에 걸릴 때 먼저 살아남게 정렬합니다.
  const ordered = [...tokens].sort((a, b) => b.length - a.length);
  for (const token of ordered) {
    if (/[가-힣]/.test(token)) {
      if (token.length < MIN_KOREAN_TOKEN_LENGTH) continue;
      if (KOREAN_STOPWORDS.has(token)) continue;
      addTerm(token);
      // 조사를 뗀 형태도 함께 넣습니다(원형을 지우지 않으므로 매칭을 잃지 않습니다).
      const stripped = stripKoreanParticle(token);
      if (stripped !== token && !KOREAN_STOPWORDS.has(stripped)) {
        addTerm(stripped);
      }
      continue;
    }
    if (token.length < MIN_LATIN_TOKEN_LENGTH) continue;
    if (LATIN_STOPWORDS.has(token.toLowerCase())) continue;
    addTerm(token);
  }

  return {
    normalized,
    terms: terms.slice(0, MAX_TERMS),
    exactSignals,
  };
}

/**
 * 주어진 텍스트에 포함된 exact 신호를 돌려줍니다(공백·대소문자 무시).
 * 본문(content)이 아니라 title/path/description/summary 같은 메타데이터에 적용하는 것을 전제로 합니다.
 */
export function matchExactSignals(
  text: string | null | undefined,
  signals: ExactSignal[],
): ExactSignal[] {
  if (!text || signals.length === 0) return [];
  const haystack = normalizeForMatch(text);
  if (haystack.length === 0) return [];
  return signals.filter((signal) =>
    haystack.includes(normalizeForMatch(signal.value)),
  );
}
