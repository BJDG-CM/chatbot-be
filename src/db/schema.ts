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
  check,
  vector,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

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

export const organizationRoleEnum = pgEnum('organization_role', [
  'MANAGER',
  'MEMBER',
]);

export const organizationMembershipStatusEnum = pgEnum(
  'organization_membership_status',
  ['PENDING', 'ACCEPTED'],
);

export const documentStatusEnum = pgEnum('document_status', [
  'uploading',
  'queued',
  'processing',
  'ready',
  'failed',
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
    normalizedEmailUnique: uniqueIndex('admins_normalized_email_unique').using(
      'btree',
      sql`lower(trim(${table.email}))`,
    ),
  }),
);

/**
 * 문서 관리 조직. 문서는 정확히 한 조직이 소유하며 다른 조직에 공유될 수 있다.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 255 }).notNull().unique(),
    isDefault: boolean('is_default').notNull().default(false),
    createdByIdpUuid: varchar('created_by_idp_uuid', { length: 255 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    defaultOrganizationUnique: uniqueIndex(
      'organizations_single_default_unique',
    )
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
    createdByIdx: index('organizations_created_by_idp_uuid_idx').on(
      table.createdByIdpUuid,
    ),
  }),
);

/** 조직 초대와 수락된 멤버십을 함께 저장한다. */
export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    inviteeEmail: varchar('invitee_email', { length: 255 }).notNull(),
    memberIdpUuid: varchar('member_idp_uuid', { length: 255 }),
    role: organizationRoleEnum('role').notNull().default('MEMBER'),
    status: organizationMembershipStatusEnum('status')
      .notNull()
      .default('PENDING'),
    invitedByIdpUuid: varchar('invited_by_idp_uuid', {
      length: 255,
    }).notNull(),
    acceptedAt: timestamp('accepted_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index('organization_memberships_organization_id_idx').on(
      table.organizationId,
    ),
    memberLookupIdx: index(
      'organization_memberships_member_idp_uuid_status_idx',
    ).on(table.memberIdpUuid, table.status),
    pendingInviteIdx: index(
      'organization_memberships_invitee_email_status_idx',
    ).on(table.inviteeEmail, table.status),
    uniqueOrganizationEmail: uniqueIndex(
      'organization_memberships_organization_id_invitee_email_unique',
    )
      .on(table.organizationId, table.inviteeEmail)
      .where(sql`${table.status} = 'PENDING'`),
    uniqueOrganizationMember: uniqueIndex(
      'organization_memberships_organization_id_member_idp_uuid_unique',
    )
      .on(table.organizationId, table.memberIdpUuid)
      .where(sql`${table.memberIdpUuid} IS NOT NULL`),
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
 * PDF 문서 테이블 (ingestion)
 * - Admin 업로드 후 비동기 Pass1/2 처리 상태와 메타를 저장
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: varchar('title', { length: 512 }).notNull(),
    resourceName: varchar('resource_name', { length: 512 }).notNull(),
    summary: text('summary'),
    gcsPdfPath: varchar('gcs_pdf_path', { length: 1024 }).notNull(),
    status: documentStatusEnum('status').notNull().default('queued'),
    errorMessage: text('error_message'),
    processingToken: uuid('processing_token'),
    uploadedByIdpUuid: varchar('uploaded_by_idp_uuid', {
      length: 255,
    }).notNull(),
    ownerOrganizationId: uuid('owner_organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    processedAt: timestamp('processed_at'),
    lastReprocessedAt: timestamp('last_reprocessed_at'),
    expiresAt: timestamp('expires_at'),
  },
  (table) => ({
    resourceNameActiveUnique: uniqueIndex(
      'documents_resource_name_active_unique',
    )
      .on(table.resourceName)
      .where(sql`${table.isActive} = true`),
    statusIdx: index('documents_status_idx').on(table.status),
    uploadedByIdpUuidIdx: index('documents_uploaded_by_idp_uuid_idx').on(
      table.uploadedByIdpUuid,
    ),
    ownerOrganizationIdIdx: index('documents_owner_organization_id_idx').on(
      table.ownerOrganizationId,
    ),
    isActiveIdx: index('documents_is_active_idx').on(table.isActive),
    createdAtIdx: index('documents_created_at_idx').on(table.createdAt),
    expiresAtIdx: index('documents_expires_at_idx').on(table.expiresAt),
  }),
);

/** text-embedding-3-large 네이티브 차원. 모델 변경 시 마이그레이션 + 전체 재임베딩 필요. */
export const CHUNK_EMBEDDING_DIMENSIONS = 3072;

/**
 * 문서 청크 테이블
 * - Pass2 의미 청킹 결과 (path / description / content)
 * - embedding: 벡터 검색용 코사인 유사도 임베딩 (null이면 미임베딩 → 백필 대상)
 *
 * 참고: lexical 검색(ILIKE)용 pg_trgm GIN 인덱스
 * (`document_chunks_path_trgm_idx` / `_description_trgm_idx` / `_content_trgm_idx`,
 * `documents_title_trgm_idx` / `documents_summary_trgm_idx`)는
 * 연산자 클래스(gin_trgm_ops)를 drizzle 스키마로 표현하지 않고
 * migration `0017_trigram_lexical_search.sql`에만 정의되어 있습니다
 * (`CREATE EXTENSION vector`를 0016에서 처리한 것과 같은 방식).
 */
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    path: varchar('path', { length: 1024 }).notNull(),
    description: text('description').notNull().default(''),
    content: text('content').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    embedding: vector('embedding', {
      dimensions: CHUNK_EMBEDDING_DIMENSIONS,
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    documentIdIdx: index('document_chunks_document_id_idx').on(
      table.documentId,
    ),
    documentSortIdx: index('document_chunks_document_sort_idx').on(
      table.documentId,
      table.sortOrder,
    ),
    pathIdx: index('document_chunks_path_idx').on(table.path),
    documentPathUnique: uniqueIndex(
      'document_chunks_document_id_path_unique',
    ).on(table.documentId, table.path),
  }),
);

/** 조직에 문서를 공유한다. 소유 조직에 대한 공유 행은 서비스에서 금지한다. */
export const documentOrganizationShares = pgTable(
  'document_organization_shares',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    sharedByIdpUuid: varchar('shared_by_idp_uuid', { length: 255 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index('document_organization_shares_document_id_idx').on(
      table.documentId,
    ),
    organizationIdx: index(
      'document_organization_shares_organization_id_idx',
    ).on(table.organizationId),
    uniqueDocumentOrganization: uniqueIndex(
      'document_organization_shares_document_id_organization_id_unique',
    ).on(table.documentId, table.organizationId),
  }),
);

/** 문서 소유권 이전 감사 로그. 정상 애플리케이션 흐름에서는 append-only이다. */
export const documentOwnershipTransfers = pgTable(
  'document_ownership_transfers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict' }),
    sourceOrganizationId: uuid('source_organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    targetOrganizationId: uuid('target_organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    actorIdpUuid: varchar('actor_idp_uuid', { length: 255 }).notNull(),
    transferredAt: timestamp('transferred_at').notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index('document_ownership_transfers_document_id_idx').on(
      table.documentId,
    ),
    sourceOrganizationIdx: index(
      'document_ownership_transfers_source_organization_id_idx',
    ).on(table.sourceOrganizationId),
    targetOrganizationIdx: index(
      'document_ownership_transfers_target_organization_id_idx',
    ).on(table.targetOrganizationId),
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
 * - 위젯 키·날짜·도메인별 토큰/요청 수 및 답변/BAD 답변 수를 실시간 누적
 * - 대시보드 조회(토큰·요청·문제 해결률 포함) 시 messages 테이블을 스캔하지 않고 이 테이블만 사용
 * - total_answers: assistant 답변이 저장될 때마다 +1 (답변 생성 날짜 기준)
 * - bad_answers: BAD 피드백이 달린 답변 수 (피드백 delta로 조정, 답변 생성 날짜 기준)
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
    totalAnswers: integer('total_answers').notNull().default(0),
    badAnswers: integer('bad_answers').notNull().default(0),
  },
  (table) => ({
    widgetKeyDateIdx: index('usage_daily_widget_key_date_idx').on(
      table.widgetKeyId,
      table.date,
    ),
    uniqueWidgetKeyDateDomain: uniqueIndex(
      'usage_daily_widget_key_id_date_domain_unique',
    ).on(table.widgetKeyId, table.date, table.domain),
    totalAnswersNonNegative: check(
      'usage_daily_total_answers_non_negative',
      sql`${table.totalAnswers} >= 0`,
    ),
    badAnswersNonNegative: check(
      'usage_daily_bad_answers_non_negative',
      sql`${table.badAnswers} >= 0`,
    ),
    badAnswersLteTotal: check(
      'usage_daily_bad_answers_lte_total',
      sql`${table.badAnswers} <= ${table.totalAnswers}`,
    ),
  }),
);

// Relations
export const organizationsRelations = relations(organizations, ({ many }) => ({
  memberships: many(organizationMemberships),
  ownedDocuments: many(documents),
  documentShares: many(documentOrganizationShares),
  outgoingTransfers: many(documentOwnershipTransfers, {
    relationName: 'transferSourceOrganization',
  }),
  incomingTransfers: many(documentOwnershipTransfers, {
    relationName: 'transferTargetOrganization',
  }),
}));

export const organizationMembershipsRelations = relations(
  organizationMemberships,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationMemberships.organizationId],
      references: [organizations.id],
    }),
  }),
);

export const documentsRelations = relations(documents, ({ one, many }) => ({
  ownerOrganization: one(organizations, {
    fields: [documents.ownerOrganizationId],
    references: [organizations.id],
  }),
  chunks: many(documentChunks),
  organizationShares: many(documentOrganizationShares),
  ownershipTransfers: many(documentOwnershipTransfers),
}));

export const documentChunksRelations = relations(documentChunks, ({ one }) => ({
  document: one(documents, {
    fields: [documentChunks.documentId],
    references: [documents.id],
  }),
}));

export const documentOrganizationSharesRelations = relations(
  documentOrganizationShares,
  ({ one }) => ({
    document: one(documents, {
      fields: [documentOrganizationShares.documentId],
      references: [documents.id],
    }),
    organization: one(organizations, {
      fields: [documentOrganizationShares.organizationId],
      references: [organizations.id],
    }),
  }),
);

export const documentOwnershipTransfersRelations = relations(
  documentOwnershipTransfers,
  ({ one }) => ({
    document: one(documents, {
      fields: [documentOwnershipTransfers.documentId],
      references: [documents.id],
    }),
    sourceOrganization: one(organizations, {
      fields: [documentOwnershipTransfers.sourceOrganizationId],
      references: [organizations.id],
      relationName: 'transferSourceOrganization',
    }),
    targetOrganization: one(organizations, {
      fields: [documentOwnershipTransfers.targetOrganizationId],
      references: [organizations.id],
      relationName: 'transferTargetOrganization',
    }),
  }),
);

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

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;

export type OrganizationMembership =
  typeof organizationMemberships.$inferSelect;
export type NewOrganizationMembership =
  typeof organizationMemberships.$inferInsert;
export type OrganizationRole = (typeof organizationRoleEnum.enumValues)[number];
export type OrganizationMembershipStatus =
  (typeof organizationMembershipStatusEnum.enumValues)[number];

export type UploadedResource = typeof uploadedResources.$inferSelect;
export type NewUploadedResource = typeof uploadedResources.$inferInsert;

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentStatus = (typeof documentStatusEnum.enumValues)[number];

export type DocumentChunk = typeof documentChunks.$inferSelect;
export type NewDocumentChunk = typeof documentChunks.$inferInsert;

export type DocumentOrganizationShare =
  typeof documentOrganizationShares.$inferSelect;
export type NewDocumentOrganizationShare =
  typeof documentOrganizationShares.$inferInsert;

export type DocumentOwnershipTransfer =
  typeof documentOwnershipTransfers.$inferSelect;
export type NewDocumentOwnershipTransfer =
  typeof documentOwnershipTransfers.$inferInsert;

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
