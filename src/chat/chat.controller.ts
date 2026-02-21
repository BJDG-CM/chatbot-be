import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  Res,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ChatService } from './services/chat.service';
import { ChatOrchestrationService } from './services/chat-orchestration.service';
import { McpResourceService } from '../mcp/mcp-resource.service';
import { WidgetSessionGuard } from '../auth/guards/widget-session.guard';
import { CurrentSession } from '../auth/decorators/current-session.decorator';
import type { SessionPayload } from '../auth/decorators/current-session.decorator';
import {
  ChatMessageInputDto,
  MessageRole,
} from '../common/dto/chat-message-input.dto';
import { ChatMessageDto } from '../common/dto/chat-message.dto';
import { PaginatedMessagesDto } from '../common/dto/paginated-messages.dto';
import { ChatRequestDto } from './dto/chat-request.dto';
import { MAX_QUESTIONS_PER_SESSION } from './constants';

@ApiTags('Widget Messages')
@Controller('api/v1/widget/messages')
@UseGuards(WidgetSessionGuard)
@ApiBearerAuth('widgetSessionAuth')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly chatOrchestrationService: ChatOrchestrationService,
    private readonly mcpResourceService: McpResourceService,
  ) {}

  @Get()
  @ApiOperation({
    summary: '대화 내역 조회 (페이징)',
    description: 'cursor 기반 페이징으로 대화 내역을 조회합니다.',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: '이전 페이지의 마지막 메시지 ID (없으면 최신순 조회)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '한 번에 가져올 메시지 개수',
    example: 20,
  })
  @ApiResponse({
    status: 200,
    description: '조회 성공',
    type: PaginatedMessagesDto,
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  async getMessages(
    @CurrentSession() session: SessionPayload,
    @Query('cursor') cursor?: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
  ): Promise<PaginatedMessagesDto> {
    return this.chatService.getMessages(session.sessionId, cursor, limit);
  }

  @Post()
  @ApiOperation({
    summary: '대화 메시지 저장',
    description: 'user 또는 assistant의 메시지를 저장합니다.',
  })
  @ApiResponse({
    status: 201,
    description: '저장 성공',
    type: ChatMessageDto,
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  @ApiResponse({
    status: 429,
    description: '세션당 질문 횟수 초과 (user 메시지 최대 5회)',
  })
  async createMessage(
    @CurrentSession() session: SessionPayload,
    @Body() dto: ChatMessageInputDto,
  ): Promise<ChatMessageDto> {
    if (dto.role === MessageRole.USER) {
      const userMessageCount = await this.chatService.getUserMessageCount(
        session.sessionId,
      );
      if (userMessageCount > MAX_QUESTIONS_PER_SESSION) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `이 세션에서는 최대 ${MAX_QUESTIONS_PER_SESSION}개의 질문만 가능합니다.`,
            limit: MAX_QUESTIONS_PER_SESSION,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return this.chatService.createMessage(session.sessionId, dto);
  }

  @Post('chat/stream')
  @ApiOperation({
    summary: '사용자 질문 처리 및 스트리밍 답변 생성',
    description:
      '사용자 질문을 받아 LLM과 MCP Tool을 조합하여 답변을 스트리밍으로 생성합니다. Server-Sent Events (SSE) 형식으로 응답을 전송합니다.',
  })
  @ApiResponse({
    status: 200,
    description: '스트리밍 시작 (text/event-stream)',
    headers: {
      'Content-Type': {
        description: 'text/event-stream',
        schema: { type: 'string' },
      },
      'Cache-Control': {
        description: 'no-cache',
        schema: { type: 'string' },
      },
      Connection: {
        description: 'keep-alive',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  @ApiResponse({
    status: 429,
    description: '세션당 질문 횟수 초과 (최대 5회)',
  })
  @ApiResponse({
    status: 500,
    description: '서버 오류 (LLM 호출 실패, Tool 실행 실패 등)',
  })
  async chatStream(
    @CurrentSession() session: SessionPayload,
    @Body() dto: ChatRequestDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const userMessageCount = await this.chatService.getUserMessageCount(
      session.sessionId,
    );
    if (userMessageCount > MAX_QUESTIONS_PER_SESSION) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `이 세션에서는 최대 ${MAX_QUESTIONS_PER_SESSION}개의 질문만 가능합니다.`,
          limit: MAX_QUESTIONS_PER_SESSION,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.chatOrchestrationService.handleStreamingResponse(
      session.sessionId,
      dto.question,
      reply,
      req,
    );
  }

  @Get('resources/*')
  @ApiOperation({
    summary: 'MCP 리소스 조회',
    description:
      'MCP 서버의 리소스(PDF, 이미지 등)를 프록시하여 제공합니다. 리소스 경로는 URL 인코딩되어야 합니다.',
  })
  @ApiParam({
    name: '*',
    description: '리소스 경로 (URL 인코딩됨)',
    type: String,
    example: '2025%20캠프%20발표자료_%201일차%20오전(학생지원,장학복지)',
  })
  @ApiResponse({
    status: 200,
    description: '리소스 조회 성공',
    content: {
      'application/pdf': {
        schema: { type: 'string', format: 'binary' },
      },
      'image/png': {
        schema: { type: 'string', format: 'binary' },
      },
      'image/jpeg': {
        schema: { type: 'string', format: 'binary' },
      },
      'text/plain': {
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: '인증 실패',
  })
  @ApiResponse({
    status: 404,
    description: '리소스를 찾을 수 없음',
  })
  async getResource(
    @CurrentSession() session: SessionPayload,
    @Param('*') resourcePath: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const decodedPath = decodeURIComponent(resourcePath);
    const resource = await this.mcpResourceService.getResource(decodedPath);

    // Content-Type 설정
    if (resource.mimeType) {
      (
        reply as FastifyReply & {
          header: (key: string, value: string) => FastifyReply;
        }
      ).header('Content-Type', resource.mimeType);
    }

    // Content-Disposition 설정 (파일 다운로드 시)
    if (
      resource.mimeType?.includes('pdf') ||
      resource.mimeType?.includes('image')
    ) {
      const filename = decodedPath.split('/').pop() || 'resource';
      (
        reply as FastifyReply & {
          header: (key: string, value: string) => FastifyReply;
        }
      ).header(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(filename)}"`,
      );
    }

    // CORS 헤더 설정
    (
      reply as FastifyReply & {
        header: (key: string, value: string) => FastifyReply;
      }
    ).header('Access-Control-Allow-Origin', '*');
    (
      reply as FastifyReply & {
        header: (key: string, value: string) => FastifyReply;
      }
    ).header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    (
      reply as FastifyReply & {
        header: (key: string, value: string) => FastifyReply;
      }
    ).header('Access-Control-Allow-Headers', 'Content-Type');

    (reply as FastifyReply & { send: (data: Buffer | string) => void }).send(
      resource.content,
    );
  }
}
