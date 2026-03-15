/**
 * 도메인 검증 유틸리티
 * OpenAPI 스펙의 도메인 검증 로직을 구현합니다.
 */

/**
 * URL에서 도메인을 추출합니다 (프로토콜 제거)
 * @param url - 전체 URL (예: https://www.example.com/path)
 * @returns 도메인 (예: www.example.com)
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    // URL 파싱 실패 시 수동으로 추출 시도
    const match = url.match(/^(?:https?:\/\/)?([^/\\?#]+)/i);
    return match ? match[1] : '';
  }
}

/**
 * 와일드카드 도메인 패턴을 정규식으로 변환합니다
 * @param pattern - 도메인 패턴 (예: *.example.com, example.com)
 * @returns 정규식
 */
function patternToRegex(pattern: string): RegExp {
  // 특수 문자 이스케이프 (단, * 제외)
  let escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // * 를 정규식 패턴으로 변환 (하나 이상의 서브도메인)
  // \\* 를 찾아서 서브도메인 패턴으로 변경
  escaped = escaped.replace(/\*/g, '[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * 도메인이 허용된 도메인 목록과 매칭되는지 확인합니다
 * @param domain - 검증할 도메인 (예: www.example.com)
 * @param allowedDomains - 허용된 도메인 패턴 배열
 * @returns 매칭 여부
 */
export function isDomainAllowed(
  domain: string,
  allowedDomains: string[],
): boolean {
  if (!domain || !allowedDomains || allowedDomains.length === 0) {
    return false;
  }

  // 도메인을 소문자로 변환하여 대소문자 무시
  const normalizedDomain = domain.toLowerCase().trim();

  for (const allowedPattern of allowedDomains) {
    const normalizedPattern = allowedPattern.toLowerCase().trim();

    // 정확히 일치하는 경우
    if (normalizedDomain === normalizedPattern) {
      return true;
    }

    // 와일드카드 패턴 매칭
    if (normalizedPattern.includes('*')) {
      const regex = patternToRegex(normalizedPattern);
      if (regex.test(normalizedDomain)) {
        return true;
      }
    }

    // 루트 도메인 매칭: allowedDomains에 "example.com"이 있으면
    // "www.example.com", "api.example.com" 등도 허용
    if (!normalizedPattern.includes('*')) {
      // normalizedDomain이 normalizedPattern으로 끝나고,
      // 그 앞에 서브도메인이 있는 경우
      if (
        normalizedDomain.endsWith(`.${normalizedPattern}`) ||
        normalizedDomain === normalizedPattern
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * appId가 허용된 앱 ID 목록에 포함되는지 확인합니다 (정확히 일치)
 * @param appId - 검증할 앱 ID (예: com.company.myapp)
 * @param allowedAppIds - 허용된 앱 ID 배열
 * @returns 매칭 여부
 */
export function isAppIdAllowed(
  appId: string,
  allowedAppIds: string[],
): boolean {
  if (!appId || !allowedAppIds || allowedAppIds.length === 0) {
    return false;
  }
  const normalized = appId.trim();
  return allowedAppIds.some((allowed) => allowed.trim() === normalized);
}

/**
 * 세션 pageUrl에서 usage 집계용 출처(도메인 또는 appId)를 추출합니다.
 * app: 접두사가 있으면 앱 클라이언트로 간주하고 나머지를 반환, 아니면 도메인 추출.
 * @param pageUrl - 세션에 저장된 pageUrl (웹은 URL, 앱은 "app:${appId}" 형식)
 * @returns usage_daily.domain에 넣을 값 (도메인 또는 appId, 없으면 'unknown')
 */
export function getSourceFromPageUrl(pageUrl: string): string {
  if (!pageUrl || typeof pageUrl !== 'string') {
    return 'unknown';
  }
  const trimmed = pageUrl.trim();
  if (trimmed.startsWith('app:')) {
    const appId = trimmed.slice(4).trim();
    return appId || 'unknown';
  }
  return extractDomain(trimmed) || 'unknown';
}

/**
 * Origin 헤더와 pageUrl에서 추출한 도메인이 일치하는지 확인합니다
 * Spoofing 방지를 위한 검증입니다
 * @param origin - Origin 헤더 값
 * @param pageUrl - pageUrl 값
 * @returns { valid: boolean, domain: string, error?: string }
 */
export function validateOriginAndPageUrl(
  origin: string | undefined,
  pageUrl: string,
): { valid: boolean; domain: string; error?: string } {
  // Origin이 없는 경우 (일부 환경)
  if (!origin) {
    const domain = extractDomain(pageUrl);
    if (!domain) {
      return {
        valid: false,
        domain: '',
        error: 'Invalid pageUrl: cannot extract domain',
      };
    }
    return { valid: true, domain };
  }

  // Origin과 pageUrl 모두 있는 경우
  const originDomain = extractDomain(origin);
  const pageUrlDomain = extractDomain(pageUrl);

  if (!originDomain || !pageUrlDomain) {
    return {
      valid: false,
      domain: '',
      error: 'Invalid origin or pageUrl format',
    };
  }

  // 도메인 불일치 (Spoofing 의심)
  if (originDomain.toLowerCase() !== pageUrlDomain.toLowerCase()) {
    return {
      valid: false,
      domain: '',
      error: 'Origin and pageUrl domain mismatch (potential spoofing)',
    };
  }

  return { valid: true, domain: originDomain };
}
