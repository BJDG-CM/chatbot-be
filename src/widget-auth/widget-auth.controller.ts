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
    description: `위젯 키와 현재 페이지의 도메인을 검증하여 세션 토큰을 발급합니다.

**검증 로직 상세:**
1. body의 pageUrl에서 도메인을 추출합니다.
2. 추출된 도메인(프로토콜 제거)이 DB의 allowedDomains 규칙과 매칭되는지 확인합니다.
3. 해당 widgetKey가 REVOKED 상태라면 발급을 거부합니다.
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
    description: '도메인 검증 실패 또는 REVOKED 된 키',
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
