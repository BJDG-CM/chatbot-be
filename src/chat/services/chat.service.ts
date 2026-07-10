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
  sessions,
} from '../../db';
import { eq, and, lt, lte, desc, count, sql } from 'drizzle-orm';
import { UsageService, computeBadAnswerDelta } from '../../usage/usage.service';
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

export interface AnswerRegenerationTarget {
  question: string;
  originalMessageId: string;
  historyBefore: Date;
}

@Injectable()
export class ChatService {
  constructor(
    @Inject(DB_CONNECTION) private db: Database,
    private readonly usageService: UsageService,
  ) {}

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

  private firstRawRow(rows: unknown): Record<string, unknown> | null {
    const raw = Array.isArray(rows)
      ? rows[0]
      : (rows as { rows?: unknown[] }).rows?.[0];

    if (!raw || typeof raw !== 'object') {
      return null;
    }

    return raw as Record<string, unknown>;
  }

  private toMetadataRecord(metadata: unknown): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    return metadata as Record<string, unknown>;
  }

  private toDate(value: unknown): Date {
    if (value instanceof Date) {
      return value;
    }

    return new Date(String(value));
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
  async getMessagesForContext(
    sessionId: string,
    beforeCreatedAt?: Date,
  ): Promise<ChatMessageDto[]> {
    const result = await this.getMessages(
      sessionId,
      undefined,
      MAX_QUESTIONS_PER_SESSION,
      beforeCreatedAt,
    );
    return result.messages;
  }

  async getMessages(
    sessionId: string,
    cursor?: string,
    limit: number = 20,
    beforeCreatedAt?: Date,
  ): Promise<PaginatedMessagesDto> {
    // cursor 기반 페이징 쿼리 구성
    const conditions = [eq(messages.sessionId, sessionId)];

    if (beforeCreatedAt) {
      conditions.push(lt(messages.createdAt, beforeCreatedAt));
    }

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
    // user 메시지는 total_answers 집계 대상이 아니므로 단순 insert.
    if (dto.role !== MessageRole.ASSISTANT) {
      const [newMessage] = await this.db
        .insert(messages)
        .values({
          sessionId,
          role: dto.role,
          content: dto.content,
          metadata: dto.metadata || null,
        })
        .returning();

      return this.toMessageDto(newMessage);
    }

    // assistant 메시지 저장과 usage_daily.total_answers 증가를 하나의 트랜잭션으로 묶어
    // "답변이 저장됐는데 집계만 실패" 하는 상태가 남지 않도록 한다.
    // 토큰 유무와 무관하게 답변이 저장되면 total_answers는 반드시 +1 된다.
    // (답변 재생성으로 새 assistant 메시지가 생기면 이 경로로 정상 +1 된다.)
    return this.db.transaction(async (tx) => {
      const [newMessage] = await tx
        .insert(messages)
        .values({
          sessionId,
          role: dto.role,
          content: dto.content,
          metadata: dto.metadata || null,
        })
        .returning();

      const [session] = await tx
        .select({
          widgetKeyId: sessions.widgetKeyId,
          pageUrl: sessions.pageUrl,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);

      if (session) {
        await this.usageService.incrementTotalAnswers(tx, {
          widgetKeyId: session.widgetKeyId,
          pageUrl: session.pageUrl,
          createdAt: newMessage.createdAt,
        });
      }

      return this.toMessageDto(newMessage);
    });
  }

  async upsertMessageFeedback(
    sessionId: string,
    messageId: string,
    dto: MessageFeedbackInputDto,
  ): Promise<MessageFeedbackDto> {
    // 피드백 upsert와 usage_daily.bad_answers delta 반영을 하나의 트랜잭션으로 묶는다.
    // 대상 message 행을 FOR UPDATE로 잠가 같은 메시지에 대한 동시 피드백 변경을 직렬화하고,
    // 이전 rating과 새 rating을 비교해 정확히 한 번만 delta를 적용한다.
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({
          id: messages.id,
          role: messages.role,
          createdAt: messages.createdAt,
          widgetKeyId: sessions.widgetKeyId,
          pageUrl: sessions.pageUrl,
        })
        .from(messages)
        .innerJoin(sessions, eq(messages.sessionId, sessions.id))
        .where(
          and(eq(messages.id, messageId), eq(messages.sessionId, sessionId)),
        )
        .for('update', { of: messages })
        .limit(1);

      if (!target) {
        throw new NotFoundException('Message not found');
      }

      if (target.role !== 'assistant') {
        throw new BadRequestException(
          'Feedback can only be submitted for assistant messages',
        );
      }

      // 잠긴 message 행 아래에서 기존 피드백 rating을 읽어 delta 판단 기준으로 삼는다.
      const [existing] = await tx
        .select({ rating: messageFeedbacks.rating })
        .from(messageFeedbacks)
        .where(eq(messageFeedbacks.messageId, messageId))
        .limit(1);
      const previousRating = existing?.rating ?? null;

      const [feedback] = await tx
        .insert(messageFeedbacks)
        .values({
          messageId,
          rating: dto.rating,
        })
        .onConflictDoUpdate({
          target: messageFeedbacks.messageId,
          set: {
            rating: dto.rating,
            updatedAt: sql`case when ${messageFeedbacks.rating} = ${dto.rating} then ${messageFeedbacks.updatedAt} else now() end`,
          },
        })
        .returning();

      if (!feedback) {
        throw new InternalServerErrorException(
          'Failed to save message feedback',
        );
      }

      // bad_answers는 피드백 등록 날짜가 아니라 답변(message) 생성 날짜·domain에 귀속시킨다.
      const delta = computeBadAnswerDelta(previousRating, feedback.rating);
      await this.usageService.applyBadAnswerDelta(tx, {
        widgetKeyId: target.widgetKeyId,
        pageUrl: target.pageUrl,
        createdAt: target.createdAt,
        delta,
      });

      return this.toMessageFeedbackDto(feedback);
    });
  }

  async getAnswerRegenerationTarget(
    sessionId: string,
    messageId: string,
  ): Promise<AnswerRegenerationTarget> {
    return this.db.transaction(async (tx) => {
      const target = this.firstRawRow(
        await tx.execute(sql`
          SELECT m.id, m.role, m.created_at, m.metadata, f.rating
          FROM messages m
          LEFT JOIN message_feedbacks f ON f.message_id = m.id
          WHERE m.id = ${messageId} AND m.session_id = ${sessionId}
          FOR UPDATE OF m
        `),
      );

      if (!target) {
        throw new NotFoundException('Message not found');
      }

      if (target.role !== 'assistant') {
        throw new BadRequestException(
          'Regeneration is only available for assistant messages',
        );
      }

      const rating = target.rating ?? target.feedback;
      if (rating !== FeedbackRating.BAD) {
        throw new BadRequestException(
          'Regeneration is only available after BAD feedback',
        );
      }

      const metadata = this.toMetadataRecord(target.metadata);
      if (
        metadata?.regeneratedFromMessageId ||
        metadata?.regenerationClaimedAt
      ) {
        throw new BadRequestException(
          'Regenerated answers cannot be regenerated again',
        );
      }

      const [existingRegeneration] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            eq(messages.role, 'assistant'),
            sql`${messages.metadata}->>'regeneratedFromMessageId' = ${messageId}`,
          ),
        )
        .limit(1);

      if (existingRegeneration) {
        throw new BadRequestException('Answer has already been regenerated');
      }

      const targetCreatedAt = this.toDate(
        target.created_at ?? target.createdAt,
      );
      const [previousUserMessage] = await tx
        .select({ content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(
            eq(messages.sessionId, sessionId),
            eq(messages.role, 'user'),
            lte(messages.createdAt, targetCreatedAt),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(1);

      if (!previousUserMessage) {
        throw new NotFoundException('Original user question not found');
      }

      await tx.execute(sql`
        UPDATE messages
        SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'regenerationClaimedAt',
          ${new Date().toISOString()}::text
        )
        WHERE id = ${messageId}
      `);

      return {
        question: previousUserMessage.content,
        originalMessageId: messageId,
        historyBefore: previousUserMessage.createdAt,
      };
    });
  }
}
