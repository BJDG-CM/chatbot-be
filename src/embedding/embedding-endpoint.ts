/**
 * 임베딩 API 엔드포인트 검증.
 *
 * 임베딩 요청은 `Authorization: Bearer <key>` 헤더와 함께 나가므로,
 * 평문 HTTP로 보내면 경로상의 공격자가 API 키와 질의 내용을 읽거나 바꿀 수 있습니다
 * (CWE-319). 그래서 HTTPS를 기본으로 요구하고, 로컬 개발 호스트만 예외로 둡니다.
 *
 * 순수 함수로 두어 앱(EmbeddingService)과 백필 스크립트가 같은 규칙을 공유합니다.
 */

/** HTTP를 허용할 로컬 개발 호스트 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * base URL이 자격 증명을 실어 보내도 안전한지 검사합니다.
 * 안전하면 끝의 슬래시를 정리한 URL을, 아니면 사유를 담은 Error를 던집니다.
 */
export function assertSecureEndpoint(rawUrl: string, label: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) {
    throw new Error(`${label} is empty`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} is not a valid URL: ${trimmed}`);
  }

  if (parsed.protocol === 'https:') return trimmed;

  if (parsed.protocol === 'http:' && isLocalHostname(parsed.hostname)) {
    return trimmed;
  }

  throw new Error(
    `${label} must use HTTPS (got ${parsed.protocol}//${parsed.hostname}). ` +
      'Plain HTTP is allowed only for localhost during development.',
  );
}

/** 임베딩에 쓸 수 있는 플랫폼. Letsur가 기본이고 OpenRouter가 대체입니다. */
export type EmbeddingCredentials = {
  provider: 'letsur' | 'openrouter';
  baseUrl: string;
  apiKey: string;
};

/**
 * 임베딩 플랫폼 자격 증명을 **쌍으로** 고릅니다.
 *
 * URL과 키를 따로 폴백하면 한쪽만 설정된 상태에서 서로 다른 공급자의 조합이 만들어져,
 * 예컨대 Letsur 엔드포인트로 OpenRouter 키가 Authorization 헤더에 실려 나갑니다.
 * HTTPS와 리디렉션 차단은 전송 구간만 보호할 뿐 키가 누구에게 가는지는 막지 못합니다.
 * 그래서 URL과 키가 모두 있는 공급자만 선택하고, 없으면 다음 공급자로 넘어갑니다.
 *
 * 앱과 백필 스크립트가 같은 규칙을 쓰도록 한곳에 둡니다.
 *
 * @returns 완전한 쌍이 없으면 null (호출부가 비활성화하거나 오류를 냅니다)
 */
export function resolveEmbeddingCredentials(
  read: (key: string) => string | undefined,
): EmbeddingCredentials | null {
  const candidates: Array<{
    provider: EmbeddingCredentials['provider'];
    urlKey: string;
    apiKeyKey: string;
  }> = [
    {
      provider: 'letsur',
      urlKey: 'LETSUR_AI_GATEWAY_BASE_URL',
      apiKeyKey: 'LETSUR_AI_GATEWAY_API_KEY',
    },
    {
      provider: 'openrouter',
      urlKey: 'OPEN_ROUTER_BASE_URL',
      apiKeyKey: 'OPEN_ROUTER_API_KEY',
    },
  ];

  for (const candidate of candidates) {
    const baseUrl = read(candidate.urlKey);
    const apiKey = read(candidate.apiKeyKey);
    if (baseUrl && apiKey) {
      return { provider: candidate.provider, baseUrl, apiKey };
    }
  }
  return null;
}
