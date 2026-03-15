import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { WidgetAuthService } from './widget-auth.service';
import { WidgetSessionRequestDto } from '../common/dto/widget-session-request.dto';
import { WidgetSessionResponseDto } from '../common/dto/widget-session-response.dto';

@ApiTags('Widget Auth')
@Controller('api/v1/widget/auth')
export class WidgetAuthController {
  constructor(private readonly widgetAuthService: WidgetAuthService) {}

  @Post('session')
  @ApiOperation({
    summary: '위젯 세션 토큰 발급',
    description: `위젯 키와 클라이언트 타입에 따라 검증 후 세션 토큰을 발급합니다.

**clientType = web (또는 생략):** body의 pageUrl에서 도메인을 추출해 allowedDomains와 매칭합니다.
**clientType = app:** body의 appId가 allowedAppIds 목록에 있는지 확인합니다.
공통: widgetKey가 REVOKED 상태라면 발급을 거부합니다.
`,
  })
  @ApiResponse({
    status: 200,
    description: '세션 발급 성공',
    type: WidgetSessionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: '잘못된 요청 (pageUrl 형식 오류 등)',
  })
  @ApiResponse({
    status: 403,
    description: '도메인/앱 ID 검증 실패 또는 REVOKED 된 키',
  })
  @ApiResponse({
    status: 404,
    description: '존재하지 않는 widgetKey',
  })
  async createSession(
    @Body() dto: WidgetSessionRequestDto,
  ): Promise<WidgetSessionResponseDto> {
    return this.widgetAuthService.createSession(dto);
  }
}
