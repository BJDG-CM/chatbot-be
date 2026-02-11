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
당신은 문서의 관련성을 판단하는 전문가입니다.

선택 기준:
- 문서 제목이나 내용이 사용자 질문의 주제와 **조금이라도 관련이 있으면** 선택하세요. 질문에 답하는 데 도움이 될 가능성이 있는 문서는 넉넉히 포함하는 편이 좋습니다.
- 의심스러우면 포함하세요. **가능하면 최소 1개 이상** 선택하세요. 명확히 무관한 문서만 제외하세요.
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

    위 문서들 중에서 사용자 질문에 **도움이 될 수 있는** 문서를 선택해주세요.

    선택 지침:
    - 문서 제목과 내용 요약을 보고, 사용자 질문과 연관되는 문서를 선택하세요. **최소 1개 이상 선택하는 것을 권장**합니다.
    - 관련 있다고 판단되는 문서는 **최대 5개까지** 넉넉히 선택하세요. 중요한 문서를 놓치지 않도록, 관련된 것은 모두 포함해도 됩니다.
    - **정말로 단 하나도 도움이 되지 않을 때만** "없음"이라고 하세요.

    응답 형식:
    - 문서 번호만 쉼표로 구분하여 나열하세요. 예: "1, 3, 5" 또는 "2, 4"
    - 설명이나 추가 텍스트 없이 번호만 입력하세요.
    - 모든 문서가 도움이 되지 않으면 "없음"이라고 답변하세요.
  `;
}
