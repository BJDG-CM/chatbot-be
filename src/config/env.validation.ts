import { plainToInstance, Transform } from 'class-transformer';
import {
  IsString,
  IsNumber,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsBase64,
  Min,
  Max,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

enum LlmProvider {
  Letsur = 'letsur',
  OpenRouter = 'openrouter',
}

/**
 * "true"/"false"만 불리언으로 변환하고, 그 외 값은 문자열 그대로 남깁니다.
 * 남은 문자열은 `@IsBoolean()`이 거부하므로 `fasle`·`0`·`off` 같은 오타가
 * 조용히 기본값으로 흡수되지 않습니다(kill-switch가 의도와 반대로 동작하는 것을 막습니다).
 * 미설정(undefined/빈 문자열)은 기존 동작을 유지하기 위해 기본값을 사용합니다.
 */
function parseBooleanEnv(defaultValue: boolean) {
  return ({ value }: { value: unknown }): unknown => {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null || value === '') {
      return defaultValue;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return value;
  };
}

/**
 * 환경 변수 검증 클래스
 * 애플리케이션 시작 시 필수 환경 변수와 형식을 검증합니다.
 */
export class EnvironmentVariables {
  // Database Configuration
  @IsString()
  @IsNotEmpty()
  DB_HOST: string;

  @IsNumber()
  @Min(1)
  @Max(65535)
  DB_PORT: number;

  @IsString()
  @IsNotEmpty()
  DB_USER: string;

  @IsString()
  @IsNotEmpty()
  DB_PASSWORD: string;

  @IsString()
  @IsNotEmpty()
  DB_NAME: string;

  @IsBoolean()
  @Transform(parseBooleanEnv(false))
  DB_SSL: boolean;

  /** DB_SSL=true일 때 신뢰할 CA 인증서(PEM). 지정하면 인증서 검증이 켜집니다. */
  @IsOptional()
  @IsString()
  DB_SSL_CA?: string;

  /**
   * DB 서버 인증서 검증 여부('true'/'false'). 미설정 시 검증하지 않고 경고만 남깁니다.
   * 불리언으로 변환하지 않는 것은 "미설정"과 "명시적 선택"을 구분해야 하기 때문입니다.
   */
  @IsOptional()
  @IsString()
  DB_SSL_REJECT_UNAUTHORIZED?: string;

  // Application Configuration
  @IsNumber()
  @Min(1)
  @Max(65535)
  PORT: number;

  @IsEnum(Environment)
  NODE_ENV: Environment;

  // JWT Configuration
  @IsString()
  @IsNotEmpty()
  @MinLength(32, {
    message: 'JWT_SECRET must be at least 32 characters long for security',
  })
  JWT_SECRET: string;

  @IsNumber()
  @Min(60)
  @Max(86400) // 최대 24시간
  JWT_EXPIRES_IN: number;

  // Admin Authentication (Legacy - Optional)
  @IsString()
  @MinLength(16, {
    message:
      'ADMIN_BEARER_TOKEN must be at least 16 characters long for security',
  })
  ADMIN_BEARER_TOKEN?: string;

  // Infoteam IDP Configuration
  @IsString()
  @IsNotEmpty()
  IDP_URL: string;

  @IsString()
  @IsNotEmpty()
  IDP_CLIENT_ID: string;

  @IsString()
  @IsNotEmpty()
  IDP_CLIENT_SECRET: string;

  // LLM Provider: letsur (default) | openrouter
  @IsOptional()
  @IsEnum(LlmProvider)
  LLM_PROVIDER?: LlmProvider;

  // Letsur AI Gateway Configuration (required when LLM_PROVIDER=letsur)
  @ValidateIf(
    (o: EnvironmentVariables) =>
      (o.LLM_PROVIDER ?? LlmProvider.Letsur) === LlmProvider.Letsur,
  )
  @IsString()
  @IsNotEmpty()
  LETSUR_AI_GATEWAY_BASE_URL: string;

  @ValidateIf(
    (o: EnvironmentVariables) =>
      (o.LLM_PROVIDER ?? LlmProvider.Letsur) === LlmProvider.Letsur,
  )
  @IsString()
  @IsNotEmpty()
  LETSUR_AI_GATEWAY_API_KEY: string;

  // OpenRouter Configuration (required when LLM_PROVIDER=openrouter)
  @ValidateIf(
    (o: EnvironmentVariables) => o.LLM_PROVIDER === LlmProvider.OpenRouter,
  )
  @IsString()
  @IsNotEmpty()
  OPEN_ROUTER_API_KEY: string;

  @IsOptional()
  @IsString()
  OPEN_ROUTER_BASE_URL?: string;

  // Embedding API (벡터 검색용). 미설정 시 Letsur 게이트웨이 설정을 재사용.

  // 기본값: text-embedding-3-large. 변경 시 차원 마이그레이션 + 전체 재임베딩 필요.
  @IsOptional()
  @IsString()
  EMBEDDING_MODEL?: string;

  /** 코사인 거리 임계값 (0~2). 이보다 먼 chunk는 관련 없음으로 제외. 기본 0.8. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  EMBEDDING_MAX_DISTANCE?: number;

  /** 벡터 검색 kill-switch. false면 항상 LLM 선별 사용. 기본 true. */
  @IsOptional()
  @IsBoolean()
  @Transform(parseBooleanEnv(true))
  EMBEDDING_RETRIEVAL_ENABLED?: boolean;

  // 벡터 검색(dense + exact 가점) 튜닝
  // 기본값은 src/retrieval/retrieval.constants.ts 참고.

  /** dense 후보 풀 크기. 최종 선택 개수보다 크게 잡아 재랭킹 여지를 만듭니다. 기본 20. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(200)
  RETRIEVAL_DENSE_CANDIDATE_LIMIT?: number;

  /** 추가 근거 없이도 통과시키는 코사인 거리. 기본 0.55. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  RETRIEVAL_STRONG_DISTANCE?: number;

  /** 최종 세부 chunk의 문서당 상한. 기본 2. */
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  RETRIEVAL_MAX_CHUNKS_PER_DOCUMENT?: number;

  // Client Domain Configuration
  @IsString()
  @IsNotEmpty()
  DOMAIN_NAME: string;

  // MCP Server URL
  @IsString()
  @IsNotEmpty()
  MCP_BASE_URL: string;

  // MCP Resource API URL
  @IsString()
  @IsNotEmpty()
  MCP_RESOURCE_API_URL: string;

  // GCS (PDF processor)
  @IsString()
  @IsNotEmpty()
  GCS_BUCKET: string;

  @IsString()
  @IsNotEmpty()
  GCP_PROJECT_ID: string;

  // Base64-encoded GCP service account JSON. When omitted, Google ADC is used.
  @IsOptional()
  @IsString()
  @IsBase64()
  GCS_SERVICE_ACCOUNT_KEY_BASE64?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1)
  PDF_PROCESSOR_CONCURRENCY?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  PDF_PROCESSOR_CONTEXT_LENGTH?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  PDF_PROCESSOR_LLM_TIMEOUT?: number;

  /** Pass 1 page LLM fallback ratio above which the job fails (0–1). Default 0.1. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  PDF_PROCESSOR_PASS1_MAX_FAILURE_RATIO?: number;

  @IsOptional()
  @IsNumber()
  @Min(500)
  PDF_PROCESSOR_POLL_INTERVAL_MS?: number;

  @IsOptional()
  @IsNumber()
  @Min(60000)
  PDF_PROCESSOR_STALE_PROCESSING_MS?: number;

  // Swagger API 문서 잠금 (둘 다 설정 시 Basic Auth 적용)
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'SWAGGER_USER must be non-empty when set' })
  SWAGGER_USER?: string;

  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'SWAGGER_PASSWORD must be non-empty when set' })
  SWAGGER_PASSWORD?: string;
}

/**
 * 환경 변수 검증 함수
 * ConfigModule에서 사용됩니다.
 */
export function validate(config: Record<string, unknown>) {
  // 문자열 'true'/'false'를 boolean으로, 문자열 숫자를 number로 변환
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const errorMessages = errors
      .map((error) => {
        const constraints = error.constraints;
        return constraints
          ? Object.values(constraints).join(', ')
          : 'Unknown validation error';
      })
      .join('\n');

    throw new Error(
      `Environment variable validation failed:\n${errorMessages}`,
    );
  }

  return validatedConfig;
}
