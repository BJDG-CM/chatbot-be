import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsUrl,
  IsOptional,
  IsIn,
  ValidateIf,
} from 'class-validator';

export class WidgetSessionRequestDto {
  @ApiProperty({
    description: '위젯 키',
    example: 'wk_live_abc123',
  })
  @IsString()
  @IsNotEmpty()
  widgetKey: string;

  @ApiPropertyOptional({
    description:
      '클라이언트 타입. web이면 pageUrl 기반 도메인 검증, app이면 appId 기반 검증. 없으면 web으로 간주.',
    enum: ['web', 'app'],
    example: 'web',
  })
  @IsOptional()
  @IsIn(['web', 'app'])
  clientType?: 'web' | 'app';

  @ApiPropertyOptional({
    description:
      '위젯이 실행된 현재 페이지 URL (clientType이 web이거나 없을 때 필수)',
    example: 'https://www.myshop.com/products/1',
  })
  @ValidateIf((o) => o.clientType !== 'app')
  @IsUrl({
    require_tld: false,
    require_protocol: true,
  })
  @IsNotEmpty({
    message: 'pageUrl is required when clientType is web or omitted',
  })
  pageUrl?: string;

  @ApiPropertyOptional({
    description:
      '앱 식별자 (clientType이 app일 때 필수). Android applicationId / iOS bundle identifier',
    example: 'com.company.myapp',
  })
  @ValidateIf((o) => o.clientType === 'app')
  @IsString()
  @IsNotEmpty({ message: 'appId is required when clientType is app' })
  appId?: string;
}
