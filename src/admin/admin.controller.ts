import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { UsageService } from '../usage/usage.service';
import { AdminJwtGuard } from '../auth/guards/admin-jwt.guard';
import { CreateWidgetKeyDto } from '../common/dto/create-widget-key.dto';
import { RegisterDomainsDto } from '../common/dto/register-domains.dto';
import { InviteCollaboratorDto } from '../common/dto/invite-collaborator.dto';
import { WidgetKeyDto } from '../common/dto/widget-key.dto';
import { CollaboratorDto } from '../common/dto/collaborator.dto';
import { WidgetKeyStatsDto } from '../common/dto/widget-key-usage.dto';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminContext } from '../auth/context/admin-context.entity';

@ApiTags('Admin Management')
@Controller('api/v1/admin')
@UseGuards(AdminJwtGuard)
@ApiBearerAuth('bearerAuth')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly usageService: UsageService,
  ) {}

  @Get('widget-keys')
  @ApiOperation({
    summary: '위젯 키 목록 조회',
    description:
      '현재 admin 유저가 만든 위젯 키 목록을 조회합니다. Admin JWT 인증이 필요합니다.',
  })
  @ApiResponse({
    status: 200,
    description: '성공',
    type: [WidgetKeyDto],
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async getAllWidgetKeys(
    @CurrentAdmin() admin: AdminContext,
  ): Promise<WidgetKeyDto[]> {
    return this.adminService.getAllWidgetKeys(admin.uuid);
  }

  @Get('widget-keys/usage')
  @ApiOperation({
    summary: '위젯 키별 사용량 통계',
    description:
      '본인이 등록한 위젯 키별·도메인별 토큰/요청 사용량을 조회합니다. Admin JWT 인증이 필요합니다.',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: '시작일 (YYYY-MM-DD), 기본값: 30일 전',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: '종료일 (YYYY-MM-DD), 기본값: 오늘',
  })
  @ApiQuery({
    name: 'widgetKeyId',
    required: false,
    type: String,
    description: '특정 위젯 키만 조회할 때',
  })
  @ApiQuery({
    name: 'domain',
    required: false,
    type: String,
    description: '특정 도메인만 필터링 (예: www.example.com)',
  })
  @ApiResponse({
    status: 200,
    description: '성공',
    type: [WidgetKeyStatsDto],
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async getWidgetKeyUsage(
    @CurrentAdmin() admin: AdminContext,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('widgetKeyId') widgetKeyId?: string,
    @Query('domain') domain?: string,
  ): Promise<WidgetKeyStatsDto[]> {
    return this.usageService.getWidgetKeyStats(admin.uuid, {
      startDate,
      endDate,
      widgetKeyId,
      domain,
    });
  }

  @Get('widget-keys/:widgetKeyId/domains')
  @ApiOperation({
    summary: '위젯 키별 등록 도메인 목록 조회',
    description:
      '특정 위젯 키에 등록된 허용 도메인 목록을 조회합니다. 사용량 API(domain 필터) 등에서 도메인별 데이터를 보기 위해 사용합니다.',
  })
  @ApiParam({
    name: 'widgetKeyId',
    description: '도메인 목록을 조회할 위젯 키의 UUID',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: '성공',
    schema: {
      type: 'object',
      properties: {
        domains: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  @ApiResponse({ status: 401, description: '인증 실패' })
  @ApiResponse({
    status: 403,
    description: '권한 없음 (본인이 만든 키가 아님)',
  })
  @ApiResponse({ status: 404, description: '존재하지 않는 Key ID' })
  async getDomains(
    @CurrentAdmin() admin: AdminContext,
    @Param('widgetKeyId') widgetKeyId: string,
  ): Promise<{ domains: string[] }> {
    return this.adminService.getDomains(widgetKeyId, admin.uuid);
  }

  @Post('widget-keys')
  @ApiOperation({
    summary: '위젯 키 생성',
    description: `새로운 위젯 키를 생성합니다. 생성된 직후 secretKey가 반환됩니다.
키 생성 후 별도로 도메인 등록 API를 호출하여 도메인을 등록해야 합니다.

**인증:** Admin JWT 인증이 필요합니다.`,
  })
  @ApiResponse({
    status: 201,
    description: '생성 성공',
    type: WidgetKeyDto,
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async createWidgetKey(
    @CurrentAdmin() admin: AdminContext,
    @Body() dto: CreateWidgetKeyDto,
  ): Promise<WidgetKeyDto> {
    return this.adminService.createWidgetKey(dto, admin.uuid);
  }

  @Post('widget-keys/:widgetKeyId/domains')
  @ApiOperation({
    summary: '도메인 등록',
    description: `기존 위젯 키에 도메인을 하나씩 등록합니다. 기존 도메인 목록에 추가됩니다.

**도메인 등록 규칙:**
- 프로토콜(https://)은 제외하고 입력하세요.
- *.example.com 와일드카드 지원.
- 이미 등록된 도메인은 중복 등록할 수 없습니다.

**인증:** Admin JWT 인증이 필요합니다.`,
  })
  @ApiParam({
    name: 'widgetKeyId',
    description: '도메인을 등록할 위젯 키의 UUID',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: '도메인 등록 성공',
    type: WidgetKeyDto,
  })
  @ApiResponse({
    status: 400,
    description: '잘못된 요청 (도메인에 프로토콜 포함, 이미 등록된 도메인 등)',
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  @ApiResponse({
    status: 403,
    description: '권한 없음 (본인이 만든 키가 아님)',
  })
  @ApiResponse({
    status: 404,
    description: '존재하지 않는 Key ID',
  })
  async registerDomains(
    @CurrentAdmin() admin: AdminContext,
    @Param('widgetKeyId') widgetKeyId: string,
    @Body() dto: RegisterDomainsDto,
  ): Promise<WidgetKeyDto> {
    return this.adminService.registerDomains(widgetKeyId, dto, admin.uuid);
  }

  @Delete('widget-keys/:widgetKeyId/domains/:domain')
  @ApiOperation({
    summary: '도메인 삭제',
    description: `기존 위젯 키에서 도메인을 삭제합니다.

**인증:** Admin JWT 인증이 필요합니다.`,
  })
  @ApiParam({
    name: 'widgetKeyId',
    description: '도메인을 삭제할 위젯 키의 UUID',
    type: String,
  })
  @ApiParam({
    name: 'domain',
    description: '삭제할 도메인 (프로토콜 제외)',
    type: String,
    example: '*.myshop.com',
  })
  @ApiResponse({
    status: 200,
    description: '도메인 삭제 성공',
    type: WidgetKeyDto,
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  @ApiResponse({
    status: 403,
    description: '권한 없음 (본인이 만든 키가 아님)',
  })
  @ApiResponse({
    status: 404,
    description: '존재하지 않는 Key ID 또는 도메인',
  })
  async removeDomain(
    @CurrentAdmin() admin: AdminContext,
    @Param('widgetKeyId') widgetKeyId: string,
    @Param('domain') domain: string,
  ): Promise<WidgetKeyDto> {
    return this.adminService.removeDomain(widgetKeyId, domain, admin.uuid);
  }

  @Patch('widget-keys/:widgetKeyId/revoke')
  @ApiOperation({
    summary: '위젯 키 폐기 (Revoke)',
    description:
      '특정 키를 REVOKED 상태로 변경하여 더 이상 세션 발급이 불가능하게 만듭니다. Admin JWT 인증이 필요합니다.',
  })
  @ApiParam({
    name: 'widgetKeyId',
    description: '폐기할 위젯 키의 UUID',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: '폐기 성공 (상태 변경됨)',
    type: WidgetKeyDto,
  })
  @ApiResponse({
    status: 403,
    description: '권한 없음 (본인이 만든 키가 아님)',
  })
  @ApiResponse({
    status: 404,
    description: '존재하지 않는 Key ID',
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async revokeWidgetKey(
    @CurrentAdmin() admin: AdminContext,
    @Param('widgetKeyId') widgetKeyId: string,
  ): Promise<WidgetKeyDto> {
    return this.adminService.revokeWidgetKey(widgetKeyId, admin.uuid);
  }

  @Post('widget-keys/:widgetKeyId/collaborators')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '협업자 초대',
    description:
      '이메일로 위젯 키 사용량 조회 권한을 공유합니다. 초대 대상이 이미 Admin이면 즉시 ACCEPTED됩니다.',
  })
  @ApiParam({
    name: 'widgetKeyId',
    description: '협업자를 초대할 위젯 키의 UUID',
    type: String,
  })
  @ApiResponse({
    status: 201,
    description: '초대 성공',
    type: CollaboratorDto,
  })
  @ApiResponse({ status: 400, description: '자기 자신 초대 불가, 중복 초대' })
  @ApiResponse({ status: 403, description: '권한 없음 (소유자만)' })
  @ApiResponse({ status: 404, description: '존재하지 않는 Key ID' })
  async inviteCollaborator(
    @CurrentAdmin() admin: AdminContext,
    @Param('widgetKeyId') widgetKeyId: string,
    @Body() dto: InviteCollaboratorDto,
  ): Promise<CollaboratorDto> {
    return this.adminService.inviteCollaborator(
      widgetKeyId,
      dto,
      admin.uuid,
      admin.email,
    );
  }

  @Get('widget-keys/:widgetKeyId/collaborators')
  @ApiOperation({
    summary: '협업자 목록 조회',
    description: '해당 위젯 키에 초대된 협업자 목록을 조회합니다. 소유자만 가능합니다.',
  })
  @ApiParam({
    name: 'widgetKeyId',
    description: '협업자 목록을 조회할 위젯 키의 UUID',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: '성공',
    type: [CollaboratorDto],
  })
  @ApiResponse({ status: 403, description: '권한 없음 (소유자만)' })
  @ApiResponse({ status: 404, description: '존재하지 않는 Key ID' })
  async getCollaborators(
    @CurrentAdmin() admin: AdminContext,
    @Param('widgetKeyId') widgetKeyId: string,
  ): Promise<CollaboratorDto[]> {
    return this.adminService.getCollaborators(widgetKeyId, admin.uuid);
  }

  @Delete('widget-keys/:widgetKeyId/collaborators/:inviteeId')
  @ApiOperation({
    summary: '협업자 제거',
    description:
      '초대된 협업자를 제거합니다. inviteeId는 GET /collaborators 목록에서 조회한 협업자 ID(UUID)를 사용합니다.',
  })
  @ApiParam({
    name: 'widgetKeyId',
    description: '협업자를 제거할 위젯 키의 UUID',
    type: String,
  })
  @ApiParam({
    name: 'inviteeId',
    description: '제거할 협업자 레코드 ID (UUID, GET /collaborators에서 반환)',
    type: String,
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiResponse({ status: 200, description: '제거 성공' })
  @ApiResponse({ status: 403, description: '권한 없음 (소유자만)' })
  @ApiResponse({ status: 404, description: '존재하지 않는 Key ID 또는 협업자' })
  async removeCollaborator(
    @CurrentAdmin() admin: AdminContext,
    @Param('widgetKeyId') widgetKeyId: string,
    @Param('inviteeId') inviteeId: string,
  ): Promise<{ message: string }> {
    await this.adminService.removeCollaborator(
      widgetKeyId,
      inviteeId,
      admin.uuid,
    );
    return { message: 'Collaborator removed successfully' };
  }
}
