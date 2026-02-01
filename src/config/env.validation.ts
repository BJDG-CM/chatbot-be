import { plainToInstance, Transform } from 'class-transformer';
import {
  IsString,
  IsNumber,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  Min,
  Max,
  MinLength,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
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
  @Transform(({ value }) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true';
    }
    return false;
  })
  DB_SSL: boolean;

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

  // Open Router Configuration
  @IsString()
  @IsNotEmpty()
  OPEN_ROUTER_API_KEY: string;

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
