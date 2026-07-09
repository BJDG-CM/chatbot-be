import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import {
  type Database,
  type Message,
  type MessageFeedback,
  messageFeedbacks,
  messages,
} from '../../db';
import { FeedbackRating } from '../../common/dto/message-feedback.dto';
import { MessageRole } from '../../common/dto/chat-message-input.dto';

class SelectBuilder<Row> implements PromiseLike<Row[]> {
  constructor(private readonly rows: Row[]) {}

  from(_table: unknown): this {
    return this;
  }

  leftJoin(_table: unknown, _condition: unknown): this {
    return this;
  }

  where(_condition: unknown): this {
    return this;
  }

  orderBy(_order: unknown): this {
    return this;
  }

  limit(_limit: number): Promise<Row[]> {
    return Promise.resolve(this.rows);
  }

  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.rows).then(onfulfilled, onrejected);
  }
}

class InsertBuilder {
  private valuesPayload: unknown;

  constructor(
    private readonly db: FakeDb,
    private readonly table: unknown,
  ) {}

  values(payload: unknown): this {
    this.valuesPayload = payload;
    return this;
  }

  onConflictDoUpdate(_config: unknown): this {
    return this;
  }

  returning(): Promise<unknown[]> {
    if (this.db.insertError) {
      return Promise.reject(this.db.insertError);
    }

    if (this.table === messageFeedbacks) {
      if (this.db.returnEmptyFeedbackInsert) {
        return Promise.resolve([]);
      }
      return Promise.resolve([this.db.upsertFeedback(this.valuesPayload)]);
    }

    if (this.table === messages) {
      return Promise.resolve([this.db.createMessage(this.valuesPayload)]);
    }

    return Promise.resolve([]);
  }
}

class FakeDb {
  readonly feedbackRows: MessageFeedback[] = [];
  executeCalls = 0;
  insertError: Error | null = null;
  returnEmptyFeedbackInsert = false;
  private readonly selectQueue: unknown[][] = [];
  private nextId = 1;

  queueSelect<Row>(rows: Row[]): void {
    this.selectQueue.push(rows);
  }

  select(_selection?: unknown): SelectBuilder<unknown> {
    return new SelectBuilder(this.selectQueue.shift() ?? []);
  }

  execute(_query: unknown): Promise<unknown[]> {
    this.executeCalls += 1;
    return Promise.resolve(this.selectQueue.shift() ?? []);
  }

  transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    return callback(this);
  }

  insert(table: unknown): InsertBuilder {
    return new InsertBuilder(this, table);
  }

  createMessage(payload: unknown): Message {
    const value = payload as {
      sessionId: string;
      role: Message['role'];
      content: string;
      metadata?: Record<string, unknown> | null;
    };
    return {
      id: `message-${this.nextId++}`,
      sessionId: value.sessionId,
      role: value.role,
      content: value.content,
      metadata: value.metadata ?? null,
      createdAt: new Date('2026-07-03T00:00:00.000Z'),
    };
  }

  upsertFeedback(payload: unknown): MessageFeedback {
    const value = payload as {
      messageId: string;
      rating: MessageFeedback['rating'];
    };
    const existing = this.feedbackRows.find(
      (row) => row.messageId === value.messageId,
    );

    if (existing) {
      if (existing.rating !== value.rating) {
        existing.rating = value.rating;
        existing.updatedAt = new Date('2026-07-03T00:01:00.000Z');
      }
      return existing;
    }

    const feedback: MessageFeedback = {
      id: `feedback-${this.nextId++}`,
      messageId: value.messageId,
      rating: value.rating,
      createdAt: new Date('2026-07-03T00:00:00.000Z'),
      updatedAt: new Date('2026-07-03T00:00:00.000Z'),
    };
    this.feedbackRows.push(feedback);
    return feedback;
  }
}

const createService = (): { service: ChatService; db: FakeDb } => {
  const db = new FakeDb();
  return {
    service: new ChatService(db as unknown as Database),
    db,
  };
};

describe('ChatService feedback', () => {
  const sessionId = 'session-1';
  const messageId = 'message-1';
  const createdAt = new Date('2026-07-03T00:00:00.000Z');

  const queueAssistantMessage = (db: FakeDb): void => {
    db.queueSelect([{ id: messageId, role: MessageRole.ASSISTANT }]);
  };

  const queueBadFeedbackTarget = (db: FakeDb): void => {
    db.queueSelect([
      {
        id: messageId,
        role: MessageRole.ASSISTANT,
        createdAt,
        metadata: null,
        feedback: FeedbackRating.BAD,
      },
    ]);
  };

  it('creates GOOD feedback for an assistant answer', async () => {
    const { service, db } = createService();
    queueAssistantMessage(db);

    const result = await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.GOOD,
    });

    expect(result).toMatchObject({
      messageId,
      rating: FeedbackRating.GOOD,
    });
    expect(db.feedbackRows).toHaveLength(1);
  });

  it('creates BAD feedback for an assistant answer', async () => {
    const { service, db } = createService();
    queueAssistantMessage(db);

    const result = await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.BAD,
    });

    expect(result.rating).toBe(FeedbackRating.BAD);
    expect(db.feedbackRows).toHaveLength(1);
  });

  it('keeps a single row when the same rating is submitted again', async () => {
    const { service, db } = createService();
    queueAssistantMessage(db);
    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.GOOD,
    });
    const firstUpdatedAt = db.feedbackRows[0].updatedAt;

    queueAssistantMessage(db);
    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.GOOD,
    });

    expect(db.feedbackRows).toHaveLength(1);
    expect(db.feedbackRows[0].rating).toBe(FeedbackRating.GOOD);
    expect(db.feedbackRows[0].updatedAt).toBe(firstUpdatedAt);
  });

  it('updates GOOD feedback to BAD without creating a history row', async () => {
    const { service, db } = createService();
    queueAssistantMessage(db);
    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.GOOD,
    });

    queueAssistantMessage(db);
    const result = await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.BAD,
    });

    expect(result.rating).toBe(FeedbackRating.BAD);
    expect(db.feedbackRows).toHaveLength(1);
  });

  it('updates BAD feedback to GOOD without creating a history row', async () => {
    const { service, db } = createService();
    queueAssistantMessage(db);
    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.BAD,
    });

    queueAssistantMessage(db);
    const result = await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.GOOD,
    });

    expect(result.rating).toBe(FeedbackRating.GOOD);
    expect(db.feedbackRows).toHaveLength(1);
  });

  it('rejects a missing or inaccessible message', async () => {
    const { service, db } = createService();
    db.queueSelect([]);

    await expect(
      service.upsertMessageFeedback(sessionId, messageId, {
        rating: FeedbackRating.GOOD,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([MessageRole.USER, 'system', 'tool'])(
    'rejects %s role messages',
    async (role) => {
      const { service, db } = createService();
      db.queueSelect([{ id: messageId, role }]);

      await expect(
        service.upsertMessageFeedback(sessionId, messageId, {
          rating: FeedbackRating.GOOD,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('propagates repository errors through the existing exception flow', async () => {
    const { service, db } = createService();
    queueAssistantMessage(db);
    db.insertError = new Error('db down');

    await expect(
      service.upsertMessageFeedback(sessionId, messageId, {
        rating: FeedbackRating.GOOD,
      }),
    ).rejects.toThrow('db down');
  });

  it('throws a server error if the feedback row cannot be returned', async () => {
    const { service, db } = createService();
    db.returnEmptyFeedbackInsert = true;
    queueAssistantMessage(db);

    await expect(
      service.upsertMessageFeedback(sessionId, messageId, {
        rating: FeedbackRating.GOOD,
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('includes feedback values when chat history is read', async () => {
    const { service, db } = createService();
    db.queueSelect([
      {
        message: {
          id: 'assistant-message',
          sessionId,
          role: MessageRole.ASSISTANT,
          content: 'answer',
          metadata: null,
          createdAt,
        },
        feedback: FeedbackRating.GOOD,
      },
      {
        message: {
          id: 'user-message',
          sessionId,
          role: MessageRole.USER,
          content: 'question',
          metadata: null,
          createdAt,
        },
        feedback: null,
      },
    ]);

    const result = await service.getMessages(sessionId);

    expect(result.messages).toEqual([
      expect.objectContaining({
        id: 'assistant-message',
        feedback: FeedbackRating.GOOD,
      }),
      expect.objectContaining({
        id: 'user-message',
        feedback: null,
      }),
    ]);
  });

  it('finds the original question for a BAD feedback answer regeneration', async () => {
    const { service, db } = createService();
    queueBadFeedbackTarget(db);
    db.queueSelect([]);
    db.queueSelect([{ content: 'original question', createdAt }]);

    const result = await service.getAnswerRegenerationTarget(
      sessionId,
      messageId,
    );

    expect(result).toEqual({
      question: 'original question',
      originalMessageId: messageId,
      historyBefore: createdAt,
    });
    expect(db.executeCalls).toBe(2);
  });

  it('rejects regeneration unless the answer has BAD feedback', async () => {
    const { service, db } = createService();
    db.queueSelect([
      {
        id: messageId,
        role: MessageRole.ASSISTANT,
        createdAt,
        metadata: null,
        feedback: FeedbackRating.GOOD,
      },
    ]);

    await expect(
      service.getAnswerRegenerationTarget(sessionId, messageId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects regeneration for an answer that has already been regenerated', async () => {
    const { service, db } = createService();
    queueBadFeedbackTarget(db);
    db.queueSelect([{ id: 'regenerated-message' }]);

    await expect(
      service.getAnswerRegenerationTarget(sessionId, messageId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects regenerating a regenerated answer again', async () => {
    const { service, db } = createService();
    db.queueSelect([
      {
        id: messageId,
        role: MessageRole.ASSISTANT,
        createdAt,
        metadata: { regeneratedFromMessageId: 'original-message' },
        feedback: FeedbackRating.BAD,
      },
    ]);

    await expect(
      service.getAnswerRegenerationTarget(sessionId, messageId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects regeneration when the original answer is already claimed', async () => {
    const { service, db } = createService();
    db.queueSelect([
      {
        id: messageId,
        role: MessageRole.ASSISTANT,
        createdAt,
        metadata: { regenerationClaimedAt: '2026-07-03T00:00:00.000Z' },
        feedback: FeedbackRating.BAD,
      },
    ]);

    await expect(
      service.getAnswerRegenerationTarget(sessionId, messageId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects regeneration when the original user question cannot be found', async () => {
    const { service, db } = createService();
    queueBadFeedbackTarget(db);
    db.queueSelect([]);
    db.queueSelect([]);

    await expect(
      service.getAnswerRegenerationTarget(sessionId, messageId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
