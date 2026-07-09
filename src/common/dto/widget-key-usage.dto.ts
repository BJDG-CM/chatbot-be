import { ApiProperty } from '@nestjs/swagger';

/**
 * 날짜별 사용량 (차트용)
 */
export class UsageDataDto {
  @ApiProperty({ description: '날짜 (YYYY-MM-DD)', example: '2025-01-15' })
  date: string;

  @ApiProperty({ description: '토큰 수', example: 1250 })
  tokens: number;

  @ApiProperty({ description: '요청 수', example: 42 })
  requests: number;

  @ApiProperty({
    description: '도메인별 필터 시 사용 (선택)',
    required: false,
    example: 'www.example.com',
  })
  domain?: string;
}

/**
 * 도메인별 통계
 */
export class DomainStatDto {
  @ApiProperty({ description: '도메인', example: 'www.example.com' })
  domain: string;

  @ApiProperty({ description: '토큰 수', example: 5000 })
  tokens: number;

  @ApiProperty({ description: '요청 수', example: 120 })
  requests: number;
}

/**
 * 위젯 키별 통계 (여러 개 반환 가능)
 */
export class WidgetKeyStatsDto {
  @ApiProperty({
    description: '위젯 키 ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  widgetKeyId: string;

  @ApiProperty({
    description: '위젯 키 이름 (표시용)',
    example: '메인 쇼핑몰용',
  })
  widgetKeyName: string;

  @ApiProperty({
    description: '실제 키 값 (표시용, 마스킹 가능)',
    example: 'wk_live_***xyz',
  })
  widgetKey: string;

  @ApiProperty({ description: '총 토큰 수', example: 15000 })
  totalTokens: number;

  @ApiProperty({ description: '총 요청 수', example: 350 })
  totalRequests: number;

  @ApiProperty({
    description:
      '문제 해결률. (1 - BAD 피드백 답변 수 / 전체 생성 답변 수) * 100',
    example: 92.5,
  })
  resolutionRate: number;

  @ApiProperty({
    description: '날짜별 시계열 데이터',
    type: [UsageDataDto],
  })
  usageData: UsageDataDto[];

  @ApiProperty({
    description: '도메인별 집계',
    type: [DomainStatDto],
  })
  domainStats: DomainStatDto[];
}
