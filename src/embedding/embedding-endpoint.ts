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
