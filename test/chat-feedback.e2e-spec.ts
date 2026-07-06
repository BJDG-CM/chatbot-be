import {
  BadRequestException,
  ExecutionContext,
  NotFoundException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ChatController } from '../src/chat/chat.controller';
import { ChatService } from '../src/chat/services/chat.service';
import { ChatOrchestrationService } from '../src/chat/services/chat-orchestration.service';
import { McpResourceService } from '../src/mcp/mcp-resource.service';
import { WidgetSessionGuard } from '../src/auth/guards/widget-session.guard';
import type { SessionPayload } from '../src/auth/decorators/current-session.decorator';
import { FeedbackRating } from '../src/common/dto/message-feedback.dto';
import { MessageRole } from '../src/common/dto/chat-message-input.dto';

type RequestWithSession = FastifyRequest & { session?: SessionPayload };

class TestWidgetSessionGuard {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithSession>();
    if (!request.headers.authorization) {
      throw new UnauthorizedException('No session token provided');
    }

    request.session = {
      sessionId: 'session-1',
      widgetKeyId: 'widget-key-1',
    };
    return true;
  }
}

describe('Chat feedback API (e2e)', () => {
  let app: NestFastifyApplication | undefined;
  const messageId = '550e8400-e29b-41d4-a716-446655440000';
  const createdAt = new Date('2026-07-03T00:00:00.000Z');
  const updatedAt = new Date('2026-07-03T00:00:10.000Z');

  const chatService = {
    getMessages: jest.fn(),
    createMessage: jest.fn(),
    getUserMessageCount: jest.fn(),
    upsertMessageFeedback: jest.fn(),
    getAnswerRegenerationTarget: jest.fn(),
  };
  const chatOrchestrationService = {
    handleStreamingResponse: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        { provide: ChatService, useValue: chatService },
        {
          provide: ChatOrchestrationService,
          useValue: chatOrchestrationService,
        },
        { provide: McpResourceService, useValue: { getResource: jest.fn() } },
      ],
    })
      .overrideGuard(WidgetSessionGuard)
      .useClass(TestWidgetSessionGuard)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        exceptionFactory: (errors) => {
          const messages = errors.map((error) =>
            Object.values(error.constraints || {}).join(', '),
          );
          return new BadRequestException({
            statusCode: 400,
            message: messages,
            error: 'Bad Request',
          });
        },
      }),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  const injectFeedback = (
    payload: unknown,
    authorization = 'Bearer test',
    targetMessageId = messageId,
  ) =>
    app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'PUT',
        url: `/api/v1/widget/messages/${targetMessageId}/feedback`,
        headers: authorization ? { authorization } : {},
        payload,
      });

  const injectRegeneration = (
    authorization = 'Bearer test',
    targetMessageId = messageId,
  ) =>
    app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/v1/widget/messages/${targetMessageId}/regenerate/stream`,
        headers: authorization ? { authorization } : {},
      });

  const streamDone = async (
    _sessionId: string,
    _question: string,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
  };

  it('accepts GOOD feedback with widget session authentication', async () => {
    chatService.upsertMessageFeedback.mockResolvedValueOnce({
      messageId,
      rating: FeedbackRating.GOOD,
      createdAt,
      updatedAt,
    });

    const response = await injectFeedback({ rating: FeedbackRating.GOOD });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toMatchObject({
      messageId,
      rating: FeedbackRating.GOOD,
    });
    expect(chatService.upsertMessageFeedback).toHaveBeenCalledWith(
      'session-1',
      messageId,
      { rating: FeedbackRating.GOOD },
    );
  });

  it('accepts BAD feedback with widget session authentication', async () => {
    chatService.upsertMessageFeedback.mockResolvedValueOnce({
      messageId,
      rating: FeedbackRating.BAD,
      createdAt,
      updatedAt,
    });

    const response = await injectFeedback({ rating: FeedbackRating.BAD });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).rating).toBe(FeedbackRating.BAD);
  });

  it('rejects invalid feedback message IDs before hitting the service', async () => {
    const response = await injectFeedback(
      { rating: FeedbackRating.BAD },
      'Bearer test',
      'not-a-uuid',
    );

    expect(response.statusCode).toBe(400);
    expect(chatService.upsertMessageFeedback).not.toHaveBeenCalled();
  });

  it('regenerates a BAD feedback answer without consuming the question limit', async () => {
    chatService.getAnswerRegenerationTarget.mockResolvedValueOnce({
      question: 'original question',
      originalMessageId: messageId,
      historyBefore: createdAt,
    });
    chatOrchestrationService.handleStreamingResponse.mockImplementationOnce(
      streamDone,
    );

    const response = await injectRegeneration();

    expect(response.statusCode).toBe(200);
    expect(chatService.getAnswerRegenerationTarget).toHaveBeenCalledWith(
      'session-1',
      messageId,
    );
    expect(chatService.getUserMessageCount).not.toHaveBeenCalled();
    expect(
      chatOrchestrationService.handleStreamingResponse,
    ).toHaveBeenCalledWith(
      'session-1',
      'original question',
      expect.anything(),
      expect.anything(),
      {
        persistUserMessage: false,
        historyBefore: createdAt,
        assistantMetadata: {
          regeneratedFromMessageId: messageId,
          regeneratedFromFeedback: FeedbackRating.BAD,
        },
      },
    );
  });

  it('rejects invalid regeneration message IDs before hitting the service', async () => {
    const response = await injectRegeneration('Bearer test', 'not-a-uuid');

    expect(response.statusCode).toBe(400);
    expect(chatService.getAnswerRegenerationTarget).not.toHaveBeenCalled();
    expect(
      chatOrchestrationService.handleStreamingResponse,
    ).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated feedback requests', async () => {
    const response = await injectFeedback({ rating: FeedbackRating.GOOD }, '');

    expect(response.statusCode).toBe(401);
    expect(chatService.upsertMessageFeedback).not.toHaveBeenCalled();
  });

  it.each([
    { rating: 'good' },
    { rating: 'LIKE' },
    { rating: true },
    { rating: null },
    { rating: '' },
    { rating: FeedbackRating.GOOD, sessionId: 'attacker-session' },
    {},
  ])('rejects invalid feedback body %#', async (payload) => {
    const response = await injectFeedback(payload);

    expect(response.statusCode).toBe(400);
    expect(chatService.upsertMessageFeedback).not.toHaveBeenCalled();
  });

  it('returns 404 for missing or other-session messages', async () => {
    chatService.upsertMessageFeedback.mockRejectedValueOnce(
      new NotFoundException('Message not found'),
    );

    const response = await injectFeedback({ rating: FeedbackRating.GOOD });

    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for user-role messages', async () => {
    chatService.upsertMessageFeedback.mockRejectedValueOnce(
      new BadRequestException(
        'Feedback can only be submitted for assistant messages',
      ),
    );

    const response = await injectFeedback({ rating: FeedbackRating.GOOD });

    expect(response.statusCode).toBe(400);
  });

  it('keeps repeat requests successful through the same idempotent endpoint', async () => {
    chatService.upsertMessageFeedback.mockResolvedValue({
      messageId,
      rating: FeedbackRating.GOOD,
      createdAt,
      updatedAt,
    });

    const first = await injectFeedback({ rating: FeedbackRating.GOOD });
    const second = await injectFeedback({ rating: FeedbackRating.GOOD });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(chatService.upsertMessageFeedback).toHaveBeenCalledTimes(2);
  });

  it('includes feedback state in chat history responses', async () => {
    chatService.getMessages.mockResolvedValueOnce({
      messages: [
        {
          id: messageId,
          role: MessageRole.ASSISTANT,
          content: 'answer',
          metadata: undefined,
          feedback: FeedbackRating.BAD,
          createdAt,
        },
        {
          id: '660e8400-e29b-41d4-a716-446655440000',
          role: MessageRole.USER,
          content: 'question',
          metadata: undefined,
          feedback: null,
          createdAt,
        },
      ],
      nextCursor: null,
    });

    const response = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/widget/messages',
        headers: { authorization: 'Bearer test' },
      });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).messages).toEqual([
      expect.objectContaining({ id: messageId, feedback: FeedbackRating.BAD }),
      expect.objectContaining({ feedback: null }),
    ]);
  });
});
