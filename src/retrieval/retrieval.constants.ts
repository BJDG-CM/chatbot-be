/**
 * 벡터 검색(dense + exact 가점) 튜닝 상수.
 *
 * 여기 값들은 실측 데이터로 고정한 값이 아니라 "합리적인 출발점"입니다.
 * 운영 데이터로 재조정할 수 있도록 한곳에 모아두고, 자주 건드릴 만한 값은
 * 환경변수로도 덮어쓸 수 있게 했습니다(VectorChunkSelectionService 참고).
 */

/**
 * dense(벡터) 후보 풀 크기. 최종 선택 개수(FINAL_CHUNK_LIMIT)보다 훨씬 크게 잡아
 * "후보 생성은 recall 우선, 최종 선택은 precision 우선" 구조를 만듭니다.
 * gold set 실측에서 5 -> 10 -> 20으로 키울 때 정답률이 89.3% -> 92.0% -> 94.7%로 올랐습니다.
 */
export const DENSE_CANDIDATE_LIMIT = 20;

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

/** dense 순위 가중치. 기준이 되는 신호이므로 1로 둡니다. */
export const RRF_DENSE_WEIGHT = 1.0;

/**
 * exact 신호 순위 가중치.
 * exact 신호(과목코드·연도·학기·날짜 등)는 precision이 매우 높고 recall이 낮은 신호라,
 * 벡터 순위만으로 밀리는 후보를 끌어올리기 위해 1보다 크게 둡니다.
 */
export const RRF_EXACT_WEIGHT = 1.5;

/**
 * 코사인 거리 상한. 이보다 먼 후보는 exact 근거가 없는 한 관련 있다고 보지 않습니다.
 *
 * gold set 115문항 실측에서 0.70과 0.75는 답변 가능 질의 정답률이 같고,
 * 관련 문서가 없어야 하는 질의를 걸러내는 비율만 8.0% -> 12.0%로 달라집니다.
 * 즉 0.75는 recall 이득 없이 오탐만 늘리므로 0.70을 씁니다.
 */
export const MAX_VECTOR_DISTANCE = 0.7;

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
 * 거리 상한 밖의 후보라도 살려줄 만큼 결정적인 exact 근거의 최소 점수.
 * title 또는 path에 exact 신호가 하나 이상 맞은 경우(= EXACT_FIELD_WEIGHTS.title)에 해당합니다.
 * 과목코드·연도처럼 한 글자만 달라도 답이 갈리는 신호가 제목에 박혀 있으면,
 * 임베딩이 그 문서를 멀게 보더라도 후보로 남깁니다.
 */
export const STRONG_EXACT_SCORE = 4;

/**
 * exact 매칭 점수 계산 시 필드별 가중치.
 * 본문이 아니라 메타데이터(title/path/description/summary)에만 적용합니다.
 */
export const EXACT_FIELD_WEIGHTS = {
  title: 4,
  path: 4,
  description: 3,
  summary: 3,
} as const;
