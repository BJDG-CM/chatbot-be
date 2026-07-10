import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import type { UsageService } from '../../usage/usage.service';
import {
  type Database,
  type Message,
  type MessageFeedback,
  messageFeedbacks,
  messages,
} from '../../db';
import { FeedbackRating } from '../../common/dto/message-feedback.dto';
import { MessageRole } from '../../common/dto/chat-message-input.dto';

type FakeUsageService = {
  incrementTotalAnswers: jest.Mock;
  applyBadAnswerDelta: jest.Mock;
};

class SelectBuilder<Row> implements PromiseLike<Row[]> {
  constructor(private readonly rows: Row[]) {}

  from(_table: unknown): this {
    return this;
  }

  leftJoin(_table: unknown, _condition: unknown): this {
    return this;
  }

  innerJoin(_table: unknown, _condition: unknown): this {
    return this;
  }

  where(_condition: unknown): this {
    return this;
  }

  for(_strength: unknown, _config?: unknown): this {
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

const createService = (): {
  service: ChatService;
  db: FakeDb;
  usageService: FakeUsageService;
} => {
  const db = new FakeDb();
  const usageService: FakeUsageService = {
    incrementTotalAnswers: jest.fn().mockResolvedValue(undefined),
    applyBadAnswerDelta: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new ChatService(
      db as unknown as Database,
      usageService as unknown as UsageService,
    ),
    db,
    usageService,
  };
};

describe('ChatService feedback', () => {
  const sessionId = 'session-1';
  const messageId = 'message-1';
  const widgetKeyId = 'widget-key-1';
  const pageUrl = 'https://www.example.com/help';
  const createdAt = new Date('2026-07-03T00:00:00.000Z');

  // upsertMessageFeedback는 (1) message+session 잠금 조회, (2) 기존 feedback rating 조회
  // 순서로 select 하므로 두 개의 결과를 큐에 넣는다. 기존 rating은 현재 feedbackRows 상태에서 파생.
  const queueFeedbackTarget = (db: FakeDb): void => {
    db.queueSelect([
      {
        id: messageId,
        role: MessageRole.ASSISTANT,
        createdAt,
        widgetKeyId,
        pageUrl,
      },
    ]);
    const existing = db.feedbackRows.find((row) => row.messageId === messageId);
    db.queueSelect(existing ? [{ rating: existing.rating }] : []);
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
    queueFeedbackTarget(db);

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
    queueFeedbackTarget(db);

    const result = await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.BAD,
    });

    expect(result.rating).toBe(FeedbackRating.BAD);
    expect(db.feedbackRows).toHaveLength(1);
  });

  it('keeps a single row when the same rating is submitted again', async () => {
    const { service, db } = createService();
    queueFeedbackTarget(db);
    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.GOOD,
    });
    const firstUpdatedAt = db.feedbackRows[0].updatedAt;

    queueFeedbackTarget(db);
    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.GOOD,
    });

    expect(db.feedbackRows).toHaveLength(1);
    expect(db.feedbackRows[0].rating).toBe(FeedbackRating.GOOD);
    expect(db.feedbackRows[0].updatedAt).toBe(firstUpdatedAt);
  });

  it('updates GOOD feedback to BAD without creating a history row', async () => {
    const { service, db } = createService();
    queueFeedbackTarget(db);
    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.GOOD,
    });

    queueFeedbackTarget(db);
    const result = await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.BAD,
    });

    expect(result.rating).toBe(FeedbackRating.BAD);
    expect(db.feedbackRows).toHaveLength(1);
  });

  it('updates BAD feedback to GOOD without creating a history row', async () => {
    const { service, db } = createService();
    queueFeedbackTarget(db);
    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.BAD,
    });

    queueFeedbackTarget(db);
    const result = await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.GOOD,
    });

    expect(result.rating).toBe(FeedbackRating.GOOD);
    expect(db.feedbackRows).toHaveLength(1);
  });

  it('applies no bad_answers delta when creating GOOD feedback (none -> GOOD)', async () => {
    const { service, db, usageService } = createService();
    queueFeedbackTarget(db);

    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.GOOD,
    });

    expect(usageService.applyBadAnswerDelta).toHaveBeenCalledTimes(1);
    expect(usageService.applyBadAnswerDelta).toHaveBeenLastCalledWith(db, {
      widgetKeyId,
      pageUrl,
      createdAt,
      delta: 0,
    });
  });

  it('adds one bad answer when creating BAD feedback (none -> BAD)', async () => {
    const { service, db, usageService } = createService();
    queueFeedbackTarget(db);

    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.BAD,
    });

    expect(usageService.applyBadAnswerDelta).toHaveBeenLastCalledWith(db, {
      widgetKeyId,
      pageUrl,
      createdAt,
      delta: 1,
    });
  });

  it.each([
    {
      label: 'GOOD -> BAD adds one bad answer',
      first: FeedbackRating.GOOD,
      second: FeedbackRating.BAD,
      expectedDelta: 1,
    },
    {
      label: 'BAD -> GOOD removes one bad answer',
      first: FeedbackRating.BAD,
      second: FeedbackRating.GOOD,
      expectedDelta: -1,
    },
    {
      label: 'GOOD -> GOOD leaves bad answers unchanged',
      first: FeedbackRating.GOOD,
      second: FeedbackRating.GOOD,
      expectedDelta: 0,
    },
    {
      label: 'BAD -> BAD leaves bad answers unchanged',
      first: FeedbackRating.BAD,
      second: FeedbackRating.BAD,
      expectedDelta: 0,
    },
  ])('$label', async ({ first, second, expectedDelta }) => {
    const { service, db, usageService } = createService();

    queueFeedbackTarget(db);
    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: first,
    });

    queueFeedbackTarget(db);
    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: second,
    });

    expect(usageService.applyBadAnswerDelta).toHaveBeenLastCalledWith(db, {
      widgetKeyId,
      pageUrl,
      createdAt,
      delta: expectedDelta,
    });
  });

  it('attributes the bad_answers delta to the answer creation date/session', async () => {
    const { service, db, usageService } = createService();
    // 과거 날짜에 생성된 답변에 오늘 피드백을 등록하는 상황.
    const pastCreatedAt = new Date('2026-07-01T10:00:00.000Z');
    db.queueSelect([
      {
        id: messageId,
        role: MessageRole.ASSISTANT,
        createdAt: pastCreatedAt,
        widgetKeyId,
        pageUrl,
      },
    ]);
    db.queueSelect([]);

    await service.upsertMessageFeedback(sessionId, messageId, {
      rating: FeedbackRating.BAD,
    });

    expect(usageService.applyBadAnswerDelta).toHaveBeenLastCalledWith(db, {
      widgetKeyId,
      pageUrl,
      createdAt: pastCreatedAt,
      delta: 1,
    });
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
    queueFeedbackTarget(db);
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
    queueFeedbackTarget(db);

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

describe('ChatService assistant answer aggregation', () => {
  const sessionId = 'session-1';
  const widgetKeyId = 'widget-key-1';
  const pageUrl = 'https://www.example.com/help';
  // FakeDb.createMessage가 부여하는 고정 createdAt
  const messageCreatedAt = new Date('2026-07-03T00:00:00.000Z');

  it('increments total_answers exactly once when an assistant message is stored', async () => {
    const { service, db, usageService } = createService();
    db.queueSelect([{ widgetKeyId, pageUrl }]); // session lookup inside the tx

    await service.createMessage(sessionId, {
      role: MessageRole.ASSISTANT,
      content: 'answer',
    });

    expect(usageService.incrementTotalAnswers).toHaveBeenCalledTimes(1);
    expect(usageService.incrementTotalAnswers).toHaveBeenCalledWith(db, {
      widgetKeyId,
      pageUrl,
      createdAt: messageCreatedAt,
    });
  });

  it('does not touch total_answers for user messages', async () => {
    const { service, usageService } = createService();

    await service.createMessage(sessionId, {
      role: MessageRole.USER,
      content: 'question',
    });

    expect(usageService.incrementTotalAnswers).not.toHaveBeenCalled();
  });

  it('increments total_answers even when no usage/token information is involved', async () => {
    // createMessage는 토큰 정보를 전혀 받지 않으므로, 답변 저장만으로 +1 되는지 확인.
    const { service, db, usageService } = createService();
    db.queueSelect([{ widgetKeyId, pageUrl }]);

    await service.createMessage(sessionId, {
      role: MessageRole.ASSISTANT,
      content: 'answer without usage metadata',
    });

    expect(usageService.incrementTotalAnswers).toHaveBeenCalledTimes(1);
  });

  it('counts a regenerated assistant answer as a separate answer', async () => {
    const { service, db, usageService } = createService();
    db.queueSelect([{ widgetKeyId, pageUrl }]);

    await service.createMessage(sessionId, {
      role: MessageRole.ASSISTANT,
      content: 'regenerated answer',
      metadata: { regeneratedFromMessageId: 'original-message' },
    });

    expect(usageService.incrementTotalAnswers).toHaveBeenCalledTimes(1);
  });

  it('does not increment total_answers when the message insert fails', async () => {
    const { service, db, usageService } = createService();
    db.insertError = new Error('db down');

    await expect(
      service.createMessage(sessionId, {
        role: MessageRole.ASSISTANT,
        content: 'answer',
      }),
    ).rejects.toThrow('db down');

    expect(usageService.incrementTotalAnswers).not.toHaveBeenCalled();
  });
});
