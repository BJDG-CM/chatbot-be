/**
 * DB 연결의 TLS 옵션 구성.
 *
 * `rejectUnauthorized: false`는 서버 인증서를 검증하지 않으므로, 경로상의 공격자가
 * 위조 인증서로 DB를 가장해 자격 증명과 문서 내용을 가로챌 수 있습니다 (CWE-295).
 *
 * 다만 관리형 DB는 대개 사설 CA로 서명된 인증서를 쓰기 때문에, 검증을 무턱대고
 * 켜면 기존 배포의 연결이 끊깁니다. 그래서 **명시적으로 설정한 경우에만** 동작을
 * 바꾸고, 설정이 없으면 기존 동작을 유지한 채 경고만 남깁니다.
 *
 *   - `DB_SSL_CA`                      : 신뢰할 CA 인증서(PEM). 검증을 켜고 이 CA를 신뢰합니다. (권장)
 *   - `DB_SSL_REJECT_UNAUTHORIZED=true`: CA를 따로 주지 않고 검증만 켭니다.
 *   - 미설정                            : 기존과 동일하게 검증하지 않습니다(경고 로그).
 */
export type DatabaseSslOptions =
  | false
  | { rejectUnauthorized: boolean; ca?: string };

export function buildDatabaseSslOptions(
  sslEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): DatabaseSslOptions {
  if (!sslEnabled) return false;

  const ca = env.DB_SSL_CA?.trim();
  if (ca) return { rejectUnauthorized: true, ca };

  // "true"/"false"만 명시적 선택으로 인정합니다. 오타가 조용히 검증을 끄면 안 됩니다.
  const explicit = env.DB_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase();
  if (explicit === 'true') return { rejectUnauthorized: true };
  if (explicit === 'false') return { rejectUnauthorized: false };

  return { rejectUnauthorized: false };
}

/**
 * TLS는 켜져 있는데 인증서 검증 설정이 없어, 위조 인증서에 노출된 상태인지 알려줍니다.
 * 호출부(앱 기동 시점)가 이 값을 보고 경고를 남깁니다.
 */
export function needsTlsVerificationWarning(
  sslEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!sslEnabled) return false;
  if (env.DB_SSL_CA?.trim()) return false;
  const explicit = env.DB_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase();
  return explicit !== 'true' && explicit !== 'false';
}

export const TLS_VERIFICATION_WARNING =
  'DB_SSL is on but the server certificate is not verified. ' +
  'Set DB_SSL_CA to your provider CA certificate (preferred) or ' +
  'DB_SSL_REJECT_UNAUTHORIZED=false to acknowledge this explicitly.';
