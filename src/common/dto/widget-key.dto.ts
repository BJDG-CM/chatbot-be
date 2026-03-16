import { ApiProperty } from '@nestjs/swagger';

export enum WidgetKeyStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

export class WidgetKeyDto {
  @ApiProperty({
    description: '위젯 키 ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  id: string;

  @ApiProperty({
    description: '위젯 키 이름',
    example: '메인 쇼핑몰용',
  })
  name: string;

  @ApiProperty({
    description: '시크릿 키',
    example: 'wk_live_xyz789',
  })
  secretKey: string;

  @ApiProperty({
    description: '위젯 키 상태',
    enum: WidgetKeyStatus,
    example: WidgetKeyStatus.ACTIVE,
  })
  status: WidgetKeyStatus;

  @ApiProperty({
    description: '허용된 도메인 목록',
    type: [String],
    example: ['myshop.com', '*.myshop.com'],
  })
  allowedDomains: string[];

  @ApiProperty({
    description: '허용된 앱 ID 목록 (Flutter/네이티브 앱용)',
    type: [String],
    example: ['com.company.myapp'],
  })
  allowedAppIds: string[];

  @ApiProperty({
    description: '생성 일시',
    example: '2024-01-08T10:30:00.000Z',
  })
  createdAt: Date;
}
