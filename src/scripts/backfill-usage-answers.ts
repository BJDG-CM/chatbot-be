/**
 * usage_daily.total_answers / bad_answers 일회성 백필 CLI 진입점.
 *
 * 배경:
 *   0008 마이그레이션으로 추가된 total_answers/bad_answers 컬럼은 기본값이 0이므로,
 *   백필하지 않으면 기존 데이터의 resolutionRate가 모두 0으로 계산된다.
 *
 * 운영 실행 절차:
 *   1. 0008 migration 적용            (bun run db:migrate)
 *   2. 백필 실행                       (bun run db:backfill:answers)
 *   3. 애플리케이션 정상 운영
 *
 *   백필은 단일 트랜잭션 안에서 messages / message_feedbacks / usage_daily 를
 *   SHARE ROW EXCLUSIVE 모드로 잠근다. 온라인 실행이 가능하지만, 실행 중에는
 *   새 assistant 답변 저장·피드백 쓰기가 백필이 끝날 때까지 잠시 대기(block)할 수 있다.
 *   (조회/SELECT는 차단되지 않는다.)
 *
 * 자동 migration에 포함하지 않는 이유:
 *   domain 파싱을 애플리케이션의 getSourceFromPageUrl() 그대로 사용하여 SQL과
 *   TypeScript 사이의 domain parsing 차이를 방지하기 위해, SQL 마이그레이션이 아니라
 *   별도 TypeScript backfill command로 실행한다.
 *
 * 멱등성:
 *   total_answers / bad_answers 를 계산한 절대값으로 SET 하므로 여러 번 실행해도
 *   값이 중복 증가하지 않는다. total_tokens / total_requests 는 변경하지 않는다.
 *
 * 실행:
 *   DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME (필요 시 DB_SSL=true) 환경 변수를 설정한 뒤
 *   `bun run db:backfill:answers`
 *   (선택) BACKFILL_LOCK_TIMEOUT_MS 로 잠금 대기 시간(ms)을 조정할 수 있다.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../db/schema';
import {
  DEFAULT_BACKFILL_LOCK_TIMEOUT_MS,
  parseLockTimeoutMs,
  runBackfill,
} from './usage-backfill';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * BACKFILL_LOCK_TIMEOUT_MS 환경변수를 해석한다.
 * 미설정이면 기본값을 사용하고, 설정된 경우(빈 문자열/비숫자/무한대/0/음수 포함)에는
 * runBackfill과 동일한 parseLockTimeoutMs로 검증하여 잘못된 값이면 문제 변수명과 함께 오류를 던진다.
 */
function resolveLockTimeoutMsFromEnv(): number {
  const raw = process.env.BACKFILL_LOCK_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_BACKFILL_LOCK_TIMEOUT_MS;
  }
  return parseLockTimeoutMs(raw, 'BACKFILL_LOCK_TIMEOUT_MS');
}

/** postgres lock 획득 실패(lock_timeout 초과) 에러 코드 */
const LOCK_NOT_AVAILABLE = '55P03';

async function main(): Promise<void> {
  // DB 연결 전에 환경변수를 검증해 잘못된 값이면 곧바로 실패한다.
  const lockTimeoutMs = resolveLockTimeoutMsFromEnv();

  const client = postgres({
    host: requireEnv('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    database: requireEnv('DB_NAME'),
    username: requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    max: 1,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  const db = drizzle(client, { schema });

  try {
    // runBackfill 내부 트랜잭션에서 오류가 나면 postgres가 자동으로 전체 롤백한다.
    const result = await runBackfill(db, { lockTimeoutMs });
    console.log(
      `[backfill-usage-answers] completed successfully. processed=${result.processed}, rows=${result.applied}`,
    );
  } finally {
    // client connection 정상 종료
    await client.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
    if (code === LOCK_NOT_AVAILABLE) {
      console.error(
        '[backfill-usage-answers] failed to acquire table lock within lock_timeout. ' +
          'Retry during lower write traffic or increase BACKFILL_LOCK_TIMEOUT_MS.',
      );
    } else {
      console.error(
        '[backfill-usage-answers] failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    process.exit(1);
  });
