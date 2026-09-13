/**
 * 하이브리드 검색(dense + lexical + exact) 튜닝 상수.
 *
 * 여기 값들은 실측 데이터로 고정한 값이 아니라 "합리적인 출발점"입니다.
 * 운영 데이터로 재조정할 수 있도록 한곳에 모아두고, 자주 건드릴 만한 값은
 * 환경변수로도 덮어쓸 수 있게 했습니다(VectorChunkSelectionService 참고).
 */

/**
 * dense(벡터) 후보 풀 크기. 최종 선택 개수(FINAL_CHUNK_LIMIT)보다 훨씬 크게 잡아
 * "후보 생성은 recall 우선, 최종 선택은 precision 우선" 구조를 만듭니다.
 */
export const DENSE_CANDIDATE_LIMIT = 20;

/** lexical(문자열 매칭) 후보 풀 크기. dense와 동일하게 두어 RRF 순위가 한쪽으로 치우치지 않게 합니다. */
export const LEXICAL_CANDIDATE_LIMIT = 20;

/** 최종적으로 답변 LLM에 넘길 세부 chunk 개수. 루트 chunk는 이 한도를 소비하지 않습니다. */
export const FINAL_CHUNK_LIMIT = 5;

/** 한 문서가 최종 세부 chunk를 독점하지 못하도록 하는 문서당 상한. */
export const MAX_CHUNKS_PER_DOCUMENT = 2;

/**
 * Reciprocal Rank Fusion 상수.
 * k=60은 RRF 원 논문(Cormack et al., 2009) 이후 관례적으로 쓰이는 값으로,
 * 상위 순위 간 점수 차이를 완만하게 만들어 한 신호가 결과를 독점하는 것을 막습니다.
 */
export const RRF_K = 60;

/** dense 순위 가중치. lexical과 동등하게 두는 것이 표준 RRF입니다. */
export const RRF_DENSE_WEIGHT = 1.0;

/** lexical 순위 가중치. */
export const RRF_LEXICAL_WEIGHT = 1.0;

/**
 * exact 신호 순위 가중치.
 * exact 신호(과목코드·연도·학기·날짜 등)는 precision이 매우 높고 recall이 낮은 신호라,
 * "한쪽 리스트에만 등장한 후보"보다 "exact 근거가 있는 후보"를 앞세우기 위해 1보다 크게 둡니다.
 */
export const RRF_EXACT_WEIGHT = 1.5;

/**
 * 코사인 거리 상한. 이보다 멀면 lexical 근거가 있어도 dense 근거로는 인정하지 않습니다.
 * PR #51에서 쓰던 값(0.75)을 그대로 승계합니다.
 */
export const MAX_VECTOR_DISTANCE = 0.75;

/**
 * "이 정도면 추가 근거 없이도 관련 있다"고 볼 수 있는 코사인 거리.
 * text-embedding-3-large 실측상 관련 질문의 상위 chunk가 대체로 이 안쪽에 들어옵니다.
 */
export const STRONG_VECTOR_DISTANCE = 0.55;

/**
 * 최상위 dense 후보와의 거리 차이 허용폭.
 * 1등과 사실상 동률인 후보가 임계값 경계에서 잘려나가는 것을 막습니다.
 */
export const VECTOR_DISTANCE_MARGIN = 0.08;

/**
 * lexical 점수만으로 후보를 살릴 때 요구하는 최소 exact 점수.
 * title/path에 exact 신호가 1개 이상 맞은 경우(= EXACT_FIELD_WEIGHTS.title)에 해당합니다.
 * 벡터 근거가 전혀 없는 후보는 이 수준의 결정적 근거가 있을 때만 통과시킵니다.
 */
export const STRONG_EXACT_SCORE = 4;

/** lexical 점수 계산 시 필드별 가중치 (DB-side ORDER BY에 그대로 사용). */
export const LEXICAL_FIELD_WEIGHTS = {
  /** 문서 제목 — 가장 강한 신호 */
  title: 4,
  /** chunk 경로 — 문서 제목 + 소제목이 들어있어 제목만큼 강함 */
  path: 4,
  /** chunk 설명 — 강함 */
  description: 2.5,
  /** 문서 요약 — 강함 */
  summary: 2,
  /** 본문 — 약함. exact 신호에 대해서만 검사합니다(아래 주석 참고). */
  content: 1,
} as const;

/**
 * exact 신호에 곱해지는 배수.
 * 일반 어휘(예: "안내", "학점")보다 과목코드·연도 같은 신호를 확실히 우대합니다.
 */
export const LEXICAL_EXACT_TERM_MULTIPLIER = 2;

/**
 * exact 매칭 점수 계산 시 필드별 가중치.
 * lexical 점수와 달리 애플리케이션에서 계산하므로 단위를 정수로 유지합니다.
 */
export const EXACT_FIELD_WEIGHTS = {
  title: 4,
  path: 4,
  description: 3,
  summary: 3,
} as const;
