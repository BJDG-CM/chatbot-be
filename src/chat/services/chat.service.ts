import {
  BadRequestException,
  Injectable,
  Inject,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  DB_CONNECTION,
  type Database,
  type Message,
  type MessageFeedback,
  messageFeedbacks,
  messages,
} from '../../db';
import { eq, and, lt, desc, count, sql } from 'drizzle-orm';
import {
  ChatMessageInputDto,
  MessageRole,
} from '../../common/dto/chat-message-input.dto';
import { ChatMessageDto } from '../../common/dto/chat-message.dto';
import { PaginatedMessagesDto } from '../../common/dto/paginated-messages.dto';
import {
  FeedbackRating,
  MessageFeedbackDto,
  MessageFeedbackInputDto,
} from '../../common/dto/message-feedback.dto';
import { MAX_QUESTIONS_PER_SESSION } from '../constants';

@Injectable()
export class ChatService {
  constructor(@Inject(DB_CONNECTION) private db: Database) {}

  private toFeedbackRating(
    rating: MessageFeedback['rating'] | null | undefined,
  ): FeedbackRating | null {
    if (rating === FeedbackRating.GOOD) {
      return FeedbackRating.GOOD;
    }
    if (rating === FeedbackRating.BAD) {
      return FeedbackRating.BAD;
    }
    return null;
  }

  private toMessageDto(
    msg: Message,
    feedback: MessageFeedback['rating'] | null = null,
  ): ChatMessageDto {
    return {
      id: msg.id,
      role: msg.role as MessageRole,
      content: msg.content,
      metadata: msg.metadata as Record<string, unknown> | undefined,
      feedback: this.toFeedbackRating(feedback),
      createdAt: msg.createdAt,
    };
  }

  private toMessageFeedbackDto(feedback: MessageFeedback): MessageFeedbackDto {
    const rating = this.toFeedbackRating(feedback.rating);
    if (!rating) {
      throw new InternalServerErrorException('Invalid message feedback rating');
    }

    return {
      messageId: feedback.messageId,
      rating,
      createdAt: feedback.createdAt,
      updatedAt: feedback.updatedAt,
    };
  }

  async getUserMessageCount(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: count() })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')));
    return Number(row?.count ?? 0);
  }

  /**
   * context용: 해당 세션의 대화 전체 조회 (최대 5개)
   */
  async getMessagesForContext(sessionId: string): Promise<ChatMessageDto[]> {
    const result = await this.getMessages(
      sessionId,
      undefined,
      MAX_QUESTIONS_PER_SESSION,
    );
    return result.messages;
  }

  async getMessages(
    sessionId: string,
    cursor?: string,
    limit: number = 20,
  ): Promise<PaginatedMessagesDto> {
    // cursor 기반 페이징 쿼리 구성
    const conditions = [eq(messages.sessionId, sessionId)];

    if (cursor) {
      // cursor보다 오래된 메시지만 조회 (createdAt 기준)
      const [cursorMessage] = await this.db
        .select()
        .from(messages)
        .where(eq(messages.id, cursor))
        .limit(1);

      if (cursorMessage) {
        conditions.push(lt(messages.createdAt, cursorMessage.createdAt));
      }
    }

    // limit + 1개를 조회하여 다음 페이지 존재 여부 확인
    const result = await this.db
      .select({
        message: messages,
        feedback: messageFeedbacks.rating,
      })
      .from(messages)
      .leftJoin(messageFeedbacks, eq(messageFeedbacks.messageId, messages.id))
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(limit + 1);

    // 다음 페이지 존재 여부 확인
    const hasMore = result.length > limit;
    const messageList = hasMore ? result.slice(0, limit) : result;

    // DTO로 변환
    const messageDtos: ChatMessageDto[] = messageList.map((row) =>
      this.toMessageDto(row.message, row.feedback),
    );

    // nextCursor 설정
    const nextCursor =
      hasMore && messageList.length > 0
        ? messageList[messageList.length - 1].message.id
        : null;

    return {
      messages: messageDtos,
      nextCursor,
    };
  }

  async createMessage(
    sessionId: string,
    dto: ChatMessageInputDto,
  ): Promise<ChatMessageDto> {
    const [newMessage] = await this.db
      .insert(messages)
      .values({
        sessionId,
        role: dto.role,
        content: dto.content,
        metadata: dto.metadata || null,
      })
      .returning();

    return {
      id: newMessage.id,
      role: newMessage.role as MessageRole,
      content: newMessage.content,
      metadata: (newMessage.metadata as Record<string, unknown>) || undefined,
      feedback: null,
      createdAt: newMessage.createdAt,
    };
  }

  async upsertMessageFeedback(
    sessionId: string,
    messageId: string,
    dto: MessageFeedbackInputDto,
  ): Promise<MessageFeedbackDto> {
    const [message] = await this.db
      .select({
        id: messages.id,
        role: messages.role,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)))
      .limit(1);

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    if (message.role !== 'assistant') {
      throw new BadRequestException(
        'Feedback can only be submitted for assistant messages',
      );
    }

    const updatedAt = new Date();
    const [feedback] = await this.db
      .insert(messageFeedbacks)
      .values({
        messageId,
        rating: dto.rating,
      })
      .onConflictDoUpdate({
        target: messageFeedbacks.messageId,
        set: {
          rating: dto.rating,
          updatedAt: sql`case when ${messageFeedbacks.rating} = ${dto.rating} then ${messageFeedbacks.updatedAt} else ${updatedAt} end`,
        },
      })
      .returning();

    if (!feedback) {
      throw new InternalServerErrorException('Failed to save message feedback');
    }

    return this.toMessageFeedbackDto(feedback);
  }
}
