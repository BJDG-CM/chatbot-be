/**
 * 문서 선택을 위한 프롬프트
 */

export interface DocumentSelectionPromptParams {
  documentList: string;
  question: string;
}

/**
 * 문서 선택 시스템 프롬프트
 */
export const DOCUMENT_SELECTION_SYSTEM_PROMPT = `
당신은 문서의 관련성을 판단하는 전문가입니다. 사용자 질문에 실제로 도움이 되는 문서만 선택하세요.

선택 기준:
- 문서 제목이나 내용이 사용자 질문의 주제와 직접적으로 관련이 있어야 합니다.
- 단순히 키워드만 일치하는 것이 아니라, 질문에 답변하는 데 실제로 유용한 정보를 제공할 수 있는 문서를 선택하세요.
- 관련성이 낮거나 불확실한 문서는 선택하지 마세요.
`;

/**
 * 문서 선택 사용자 프롬프트 생성
 */
export function getDocumentSelectionUserPrompt(
  params: DocumentSelectionPromptParams,
): string {
  const { documentList, question } = params;

  return `
    다음은 사용자 질문에 대한 후보 문서 목록입니다 (제목 + 내용 요약):

    ${documentList}

    사용자 질문: "${question}"

    위 문서들 중에서 사용자 질문에 **실제로 도움이 되는** 문서만 선택해주세요.

    선택 지침:
    - 문서 제목과 내용 요약을 보고, 사용자 질문의 주제와 직접적으로 관련 있는 문서를 선택하세요.
    - 질문에 답변하는 데 필요한 정보를 제공할 수 있는 문서를 선택하세요.
    - **최대 3개까지만** 선택하세요. 가장 관련성이 높은 문서만 선택하세요.
    - 관련성이 낮거나 불확실한 문서는 선택하지 마세요.

    응답 형식:
    - 문서 번호만 쉼표로 구분하여 나열하세요. 예: "1, 3, 5" 또는 "2, 4"
    - 모든 문서가 도움이 되지 않으면 "없음"이라고 답변하세요.
    - 설명이나 추가 텍스트 없이 번호만 입력하세요.
  `;
}
