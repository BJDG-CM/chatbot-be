import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  pgEnum,
  jsonb,
  text,
  index,
  boolean,
  integer,
  date,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enums
export const widgetKeyStatusEnum = pgEnum('widget_key_status', [
  'ACTIVE',
  'REVOKED',
]);

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant']);

export const messageFeedbackRatingEnum = pgEnum('message_feedback_rating', [
  'GOOD',
  'BAD',
]);

export const adminRoleEnum = pgEnum('admin_role', ['SUPER_ADMIN', 'ADMIN']);

export const collaboratorRoleEnum = pgEnum('collaborator_role', ['VIEWER']);

export const collaboratorStatusEnum = pgEnum('collaborator_status', [
  'PENDING',
  'ACCEPTED',
]);

// Tables

/**
 * Admin 유저 테이블
 * - IDP 인증된 Admin 사용자 정보를 저장
 */
export const admins = pgTable(
  'admins',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    idpUuid: varchar('idp_uuid', { length: 255 }).notNull().unique(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    role: adminRoleEnum('role').notNull().default('ADMIN'),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    idpUuidIdx: index('admins_idp_uuid_idx').on(table.idpUuid),
    emailIdx: index('admins_email_idx').on(table.email),
  }),
);
/**
 * 위젯 키 테이블
 * - 위젯 인증에 사용되는 키 정보를 저장
 */
export const widgetKeys = pgTable(
  'widget_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    secretKey: varchar('secret_key', { length: 255 }).notNull().unique(),
    status: widgetKeyStatusEnum('status').notNull().default('ACTIVE'),
    allowedDomains: jsonb('allowed_domains')
      .notNull()
      .$type<string[]>()
      .default([]),
    allowedAppIds: jsonb('allowed_app_ids')
      .notNull()
      .$type<string[]>()
      .default([]),
    createdByIdpUuid: varchar('created_by_idp_uuid', { length: 255 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    secretKeyIdx: index('widget_keys_secret_key_idx').on(table.secretKey),
    statusIdx: index('widget_keys_status_idx').on(table.status),
    createdByIdpUuidIdx: index('widget_keys_created_by_idp_uuid_idx').on(
      table.createdByIdpUuid,
    ),
  }),
);

/**
 * 위젯 키 협업자 테이블
 * - 이메일 기반으로 위젯 키 사용량 조회 권한 공유
 */
export const widgetKeyCollaborators = pgTable(
  'widget_key_collaborators',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    widgetKeyId: uuid('widget_key_id')
      .notNull()
      .references(() => widgetKeys.id, { onDelete: 'cascade' }),
    inviteeEmail: varchar('invitee_email', { length: 255 }).notNull(),
    inviteeIdpUuid: varchar('invitee_idp_uuid', { length: 255 }),
    role: collaboratorRoleEnum('role').notNull().default('VIEWER'),
    status: collaboratorStatusEnum('status').notNull().default('PENDING'),
    invitedByIdpUuid: varchar('invited_by_idp_uuid', {
      length: 255,
    }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    widgetKeyIdIdx: index('widget_key_collaborators_widget_key_id_idx').on(
      table.widgetKeyId,
    ),
    inviteeEmailIdx: index('widget_key_collaborators_invitee_email_idx').on(
      table.inviteeEmail,
    ),
    inviteeIdpUuidIdx: index(
      'widget_key_collaborators_invitee_idp_uuid_idx',
    ).on(table.inviteeIdpUuid),
    uniqueWidgetKeyInvitee: uniqueIndex(
      'widget_key_collaborators_widget_key_id_invitee_email_unique',
    ).on(table.widgetKeyId, table.inviteeEmail),
  }),
);

/**
 * 세션 테이블
 * - 위젯에서 발급받은 세션 토큰 정보를 저장
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    widgetKeyId: uuid('widget_key_id')
      .notNull()
      .references(() => widgetKeys.id, { onDelete: 'cascade' }),
    sessionToken: text('session_token').notNull().unique(),
    pageUrl: varchar('page_url', { length: 2048 }).notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    sessionTokenIdx: index('sessions_session_token_idx').on(table.sessionToken),
    widgetKeyIdIdx: index('sessions_widget_key_id_idx').on(table.widgetKeyId),
    expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt),
  }),
);

/**
 * resource-center 업로드 응답 메타데이터 타입
 * (resource_name, status, queued_for_processing, message_id, gcs_path 등)
 */
export type UploadedResourceMetadata = Record<string, unknown>;

/**
 * 업로드 리소스 테이블
 * - super_admin이 resource-center에 업로드한 파일 메타데이터 기록
 */
export const uploadedResources = pgTable(
  'uploaded_resources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: varchar('title', { length: 512 }).notNull(),
    metadata: jsonb('metadata').$type<UploadedResourceMetadata>().notNull(),
    uploadedByIdpUuid: varchar('uploaded_by_idp_uuid', {
      length: 255,
    }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    uploadedByIdpUuidIdx: index(
      'uploaded_resources_uploaded_by_idp_uuid_idx',
    ).on(table.uploadedByIdpUuid),
    isActiveIdx: index('uploaded_resources_is_active_idx').on(table.isActive),
    createdAtIdx: index('uploaded_resources_created_at_idx').on(
      table.createdAt,
    ),
  }),
);

/**
 * 메시지 테이블
 * - 채팅 메시지를 저장
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    sessionIdIdx: index('messages_session_id_idx').on(table.sessionId),
    createdAtIdx: index('messages_created_at_idx').on(table.createdAt),
    sessionCreatedIdx: index('messages_session_created_idx').on(
      table.sessionId,
      table.createdAt,
    ),
  }),
);

/**
 * 메시지 피드백 테이블
 * - assistant 답변에 대한 현재 문제 해결 여부 피드백을 저장
 */
export const messageFeedbacks = pgTable(
  'message_feedbacks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    rating: messageFeedbackRatingEnum('rating').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    messageIdUnique: uniqueIndex('message_feedbacks_message_id_unique').on(
      table.messageId,
    ),
    ratingCreatedAtIdx: index('message_feedbacks_rating_created_at_idx').on(
      table.rating,
      table.createdAt,
    ),
  }),
);

/**
 * 일별 사용량 집계 테이블
 * - 위젯 키·날짜·도메인별 토큰/요청 수를 실시간 누적
 * - 대시보드 조회 시 messages 테이블을 스캔하지 않고 이 테이블만 사용
 */
export const usageDaily = pgTable(
  'usage_daily',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    widgetKeyId: uuid('widget_key_id')
      .notNull()
      .references(() => widgetKeys.id, { onDelete: 'cascade' }),
    date: date('date', { mode: 'string' }).notNull(),
    domain: varchar('domain', { length: 512 }).notNull(),
    totalTokens: integer('total_tokens').notNull().default(0),
    totalRequests: integer('total_requests').notNull().default(0),
  },
  (table) => ({
    widgetKeyDateIdx: index('usage_daily_widget_key_date_idx').on(
      table.widgetKeyId,
      table.date,
    ),
    uniqueWidgetKeyDateDomain: uniqueIndex(
      'usage_daily_widget_key_id_date_domain_unique',
    ).on(table.widgetKeyId, table.date, table.domain),
  }),
);

// Relations
export const widgetKeysRelations = relations(widgetKeys, ({ many }) => ({
  sessions: many(sessions),
  usageDaily: many(usageDaily),
  collaborators: many(widgetKeyCollaborators),
}));

export const widgetKeyCollaboratorsRelations = relations(
  widgetKeyCollaborators,
  ({ one }) => ({
    widgetKey: one(widgetKeys, {
      fields: [widgetKeyCollaborators.widgetKeyId],
      references: [widgetKeys.id],
    }),
  }),
);

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  widgetKey: one(widgetKeys, {
    fields: [sessions.widgetKeyId],
    references: [widgetKeys.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  session: one(sessions, {
    fields: [messages.sessionId],
    references: [sessions.id],
  }),
  feedback: one(messageFeedbacks, {
    fields: [messages.id],
    references: [messageFeedbacks.messageId],
  }),
}));

export const messageFeedbacksRelations = relations(
  messageFeedbacks,
  ({ one }) => ({
    message: one(messages, {
      fields: [messageFeedbacks.messageId],
      references: [messages.id],
    }),
  }),
);

export const usageDailyRelations = relations(usageDaily, ({ one }) => ({
  widgetKey: one(widgetKeys, {
    fields: [usageDaily.widgetKeyId],
    references: [widgetKeys.id],
  }),
}));

// Types
export type Admin = typeof admins.$inferSelect;
export type NewAdmin = typeof admins.$inferInsert;

export type UploadedResource = typeof uploadedResources.$inferSelect;
export type NewUploadedResource = typeof uploadedResources.$inferInsert;

export type WidgetKey = typeof widgetKeys.$inferSelect;
export type NewWidgetKey = typeof widgetKeys.$inferInsert;

export type WidgetKeyCollaborator = typeof widgetKeyCollaborators.$inferSelect;
export type NewWidgetKeyCollaborator =
  typeof widgetKeyCollaborators.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type MessageFeedback = typeof messageFeedbacks.$inferSelect;
export type NewMessageFeedback = typeof messageFeedbacks.$inferInsert;

export type UsageDaily = typeof usageDaily.$inferSelect;
export type NewUsageDaily = typeof usageDaily.$inferInsert;
