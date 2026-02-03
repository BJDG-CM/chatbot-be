/**
 * 문서 경로(목록) 선별을 위한 프롬프트
 * 사용자 질문과 문서 경로/제목만 보고, 관련 있는 문서 번호를 LLM이 선택합니다.
 */

export interface ResourcePathSelectionPromptParams {
  pathList: string;
  question: string;
  maxSelect: number;
}

/**
 * 리소스 경로 선별 시스템 프롬프트
 */
export const RESOURCE_PATH_SELECTION_SYSTEM_PROMPT = `
당신은 사용자 질문과 문서 경로(제목)의 관련성을 판단하는 전문가입니다.

선택 기준:
- 문서 경로·제목이 사용자 질문의 **의미·맥락**과 관련이 있어야 합니다. 단순 키워드 일치가 아니라 질문에 답하는 데 도움이 될 만한 문서를 선택하세요.
- 예: "장학금 신청" 질문에는 "학생지원", "장학복지", "지원금" 등 관련 경로를 선택하세요.
- 관련성이 낮거나 불확실한 문서는 선택하지 마세요.
`;

/**
 * 리소스 경로 선별 사용자 프롬프트 생성
 */
export function getResourcePathSelectionUserPrompt(
  params: ResourcePathSelectionPromptParams,
): string {
  const { pathList, question, maxSelect } = params;

  return `
다음은 사용 가능한 문서 목록입니다 (번호. 경로/제목):

${pathList}

사용자 질문: "${question}"

위 목록에서 사용자 질문과 **의미·맥락상 관련 있는** 문서 번호만 선택해주세요.

선택 지침:
- 질문에 답변하는 데 도움이 될 만한 문서를 최대 ${maxSelect}개까지 선택하세요.
- 관련 없는 문서는 선택하지 마세요.

응답 형식:
- 문서 번호만 쉼표로 구분하여 나열하세요. 예: "1, 3, 5" 또는 "2, 4"
- 관련 있는 문서가 없으면 "없음"이라고 답변하세요.
- 설명 없이 번호만 입력하세요.
`;
}
