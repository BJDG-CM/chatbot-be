import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  DB_CONNECTION,
  type Database,
  widgetKeys,
  widgetKeyCollaborators,
  admins,
} from '../db';
import { and, eq, ne } from 'drizzle-orm';
import { generateWidgetKey } from '../common/utils/widget-key-generator.util';
import { CreateWidgetKeyDto } from '../common/dto/create-widget-key.dto';
import { RegisterDomainsDto } from '../common/dto/register-domains.dto';
import { InviteCollaboratorDto } from '../common/dto/invite-collaborator.dto';
import { WidgetKeyDto, WidgetKeyStatus } from '../common/dto/widget-key.dto';
import { CollaboratorDto } from '../common/dto/collaborator.dto';

@Injectable()
export class AdminService {
  constructor(@Inject(DB_CONNECTION) private db: Database) {}

  async getDomains(
    widgetKeyId: string,
    adminUuid: string,
  ): Promise<{ domains: string[] }> {
    const [key] = await this.db
      .select({
        allowedDomains: widgetKeys.allowedDomains,
        createdByIdpUuid: widgetKeys.createdByIdpUuid,
      })
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!key) {
      throw new NotFoundException('Widget key not found');
    }

    if (key.createdByIdpUuid !== adminUuid) {
      throw new ForbiddenException(
        'You do not have permission to view this widget key',
      );
    }

    return { domains: key.allowedDomains ?? [] };
  }

  async getAllWidgetKeys(adminUuid: string): Promise<WidgetKeyDto[]> {
    // 소유 키
    const ownedKeys = await this.db
      .select()
      .from(widgetKeys)
      .where(
        and(
          eq(widgetKeys.createdByIdpUuid, adminUuid),
          ne(widgetKeys.status, 'REVOKED'),
        ),
      );

    // 협업자로 접근 가능한 키 (ACCEPTED, invitee_idp_uuid 매칭)
    const sharedKeys = await this.db
      .select({
        id: widgetKeys.id,
        name: widgetKeys.name,
        secretKey: widgetKeys.secretKey,
        status: widgetKeys.status,
        allowedDomains: widgetKeys.allowedDomains,
        createdAt: widgetKeys.createdAt,
      })
      .from(widgetKeyCollaborators)
      .innerJoin(
        widgetKeys,
        eq(widgetKeyCollaborators.widgetKeyId, widgetKeys.id),
      )
      .where(
        and(
          eq(widgetKeyCollaborators.inviteeIdpUuid, adminUuid),
          eq(widgetKeyCollaborators.status, 'ACCEPTED'),
          ne(widgetKeys.status, 'REVOKED'),
        ),
      );

    const result: WidgetKeyDto[] = [
      ...ownedKeys.map((key) => ({
        id: key.id,
        name: key.name,
        secretKey: key.secretKey,
        status: key.status as WidgetKeyStatus,
        allowedDomains: key.allowedDomains,
        createdAt: key.createdAt,
      })),
      ...sharedKeys.map((key) => ({
        id: key.id,
        name: key.name,
        secretKey: '***', // 협업자(VIEWER)는 실제 키 노출 안 함
        status: key.status as WidgetKeyStatus,
        allowedDomains: key.allowedDomains,
        createdAt: key.createdAt,
      })),
    ];

    // id 기준 중복 제거 (소유자이면서 협업자인 경우 소유자 데이터 우선)
    const seen = new Set<string>();
    return result.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  async createWidgetKey(
    dto: CreateWidgetKeyDto,
    adminUuid: string,
  ): Promise<WidgetKeyDto> {
    // 고유한 secretKey 생성 (중복 방지)
    let secretKey: string;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      secretKey = generateWidgetKey();

      // 중복 확인
      const [existing] = await this.db
        .select()
        .from(widgetKeys)
        .where(eq(widgetKeys.secretKey, secretKey))
        .limit(1);

      if (!existing) {
        break;
      }

      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new BadRequestException('Failed to generate unique widget key');
    }

    // DB에 저장 (도메인 없이)
    const [newKey] = await this.db
      .insert(widgetKeys)
      .values({
        name: dto.name,
        secretKey: secretKey!,
        status: 'ACTIVE',
        allowedDomains: [],
        createdByIdpUuid: adminUuid,
      })
      .returning();

    return {
      id: newKey.id,
      name: newKey.name,
      secretKey: newKey.secretKey,
      status: newKey.status as WidgetKeyStatus,
      allowedDomains: newKey.allowedDomains,
      createdAt: newKey.createdAt,
    };
  }

  async registerDomains(
    widgetKeyId: string,
    dto: RegisterDomainsDto,
    adminUuid: string,
  ): Promise<WidgetKeyDto> {
    // 키 존재 여부 및 소유자 확인
    const [existingKey] = await this.db
      .select()
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!existingKey) {
      throw new NotFoundException('Widget key not found');
    }

    if (existingKey.createdByIdpUuid !== adminUuid) {
      throw new ForbiddenException(
        'You do not have permission to modify this widget key',
      );
    }

    // 도메인에 프로토콜이 포함되어 있는지 검증
    if (dto.domain.includes('://')) {
      throw new BadRequestException(
        'Domain should not include protocol (https://). Please remove the protocol.',
      );
    }

    // 기존 도메인 목록 가져오기
    const existingDomains = existingKey.allowedDomains || [];

    // 이미 등록된 도메인이면 에러 반환
    if (existingDomains.includes(dto.domain)) {
      throw new BadRequestException('Domain already exists');
    }

    // 도메인 추가
    const updatedDomains = [...existingDomains, dto.domain];

    // DB 업데이트
    const [updatedKey] = await this.db
      .update(widgetKeys)
      .set({
        allowedDomains: updatedDomains,
        updatedAt: new Date(),
      })
      .where(eq(widgetKeys.id, widgetKeyId))
      .returning();

    return {
      id: updatedKey.id,
      name: updatedKey.name,
      secretKey: updatedKey.secretKey,
      status: updatedKey.status as WidgetKeyStatus,
      allowedDomains: updatedKey.allowedDomains,
      createdAt: updatedKey.createdAt,
    };
  }

  async revokeWidgetKey(
    widgetKeyId: string,
    adminUuid: string,
  ): Promise<WidgetKeyDto> {
    // 키 존재 여부 및 소유자 확인
    const [existingKey] = await this.db
      .select()
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!existingKey) {
      throw new NotFoundException('Widget key not found');
    }

    if (existingKey.createdByIdpUuid !== adminUuid) {
      throw new ForbiddenException(
        'You do not have permission to revoke this widget key',
      );
    }

    // status를 REVOKED로 변경
    const [updatedKey] = await this.db
      .update(widgetKeys)
      .set({
        status: 'REVOKED',
        updatedAt: new Date(),
      })
      .where(eq(widgetKeys.id, widgetKeyId))
      .returning();

    return {
      id: updatedKey.id,
      name: updatedKey.name,
      secretKey: updatedKey.secretKey,
      status: updatedKey.status as WidgetKeyStatus,
      allowedDomains: updatedKey.allowedDomains,
      createdAt: updatedKey.createdAt,
    };
  }

  async removeDomain(
    widgetKeyId: string,
    domain: string,
    adminUuid: string,
  ): Promise<WidgetKeyDto> {
    // 키 존재 여부 및 소유자 확인
    const [existingKey] = await this.db
      .select()
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!existingKey) {
      throw new NotFoundException('Widget key not found');
    }

    if (existingKey.createdByIdpUuid !== adminUuid) {
      throw new ForbiddenException(
        'You do not have permission to modify this widget key',
      );
    }

    // 기존 도메인 목록 가져오기
    const existingDomains = existingKey.allowedDomains || [];

    // 도메인이 존재하지 않으면 에러 반환
    if (!existingDomains.includes(domain)) {
      throw new NotFoundException('Domain not found');
    }

    // 도메인 제거
    const updatedDomains = existingDomains.filter((d) => d !== domain);

    // DB 업데이트
    const [updatedKey] = await this.db
      .update(widgetKeys)
      .set({
        allowedDomains: updatedDomains,
        updatedAt: new Date(),
      })
      .where(eq(widgetKeys.id, widgetKeyId))
      .returning();

    return {
      id: updatedKey.id,
      name: updatedKey.name,
      secretKey: updatedKey.secretKey,
      status: updatedKey.status as WidgetKeyStatus,
      allowedDomains: updatedKey.allowedDomains,
      createdAt: updatedKey.createdAt,
    };
  }

  async inviteCollaborator(
    widgetKeyId: string,
    dto: InviteCollaboratorDto,
    adminUuid: string,
    adminEmail: string,
  ): Promise<CollaboratorDto> {
    const [key] = await this.db
      .select({
        id: widgetKeys.id,
        createdByIdpUuid: widgetKeys.createdByIdpUuid,
      })
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!key) {
      throw new NotFoundException('Widget key not found');
    }
    if (key.createdByIdpUuid !== adminUuid) {
      throw new ForbiddenException(
        'You do not have permission to invite collaborators to this widget key',
      );
    }

    const normalizedEmail = dto.inviteeEmail.toLowerCase().trim();
    if (normalizedEmail === adminEmail.toLowerCase().trim()) {
      throw new BadRequestException('Cannot invite yourself');
    }

    const [existing] = await this.db
      .select()
      .from(widgetKeyCollaborators)
      .where(
        and(
          eq(widgetKeyCollaborators.widgetKeyId, widgetKeyId),
          eq(widgetKeyCollaborators.inviteeEmail, normalizedEmail),
        ),
      )
      .limit(1);

    if (existing) {
      throw new BadRequestException(
        'This email has already been invited to this widget key',
      );
    }

    // 기존 Admin이면 즉시 ACCEPTED + invitee_idp_uuid 설정
    const [inviteeAdmin] = await this.db
      .select({ idpUuid: admins.idpUuid })
      .from(admins)
      .where(eq(admins.email, normalizedEmail))
      .limit(1);

    const [collaborator] = await this.db
      .insert(widgetKeyCollaborators)
      .values({
        widgetKeyId,
        inviteeEmail: normalizedEmail,
        inviteeIdpUuid: inviteeAdmin?.idpUuid ?? null,
        status: inviteeAdmin ? 'ACCEPTED' : 'PENDING',
        invitedByIdpUuid: adminUuid,
      })
      .returning();

    return {
      id: collaborator.id,
      inviteeEmail: collaborator.inviteeEmail,
      role: collaborator.role,
      status: collaborator.status,
      createdAt: collaborator.createdAt,
    };
  }

  async getCollaborators(
    widgetKeyId: string,
    adminUuid: string,
  ): Promise<CollaboratorDto[]> {
    const [key] = await this.db
      .select({ createdByIdpUuid: widgetKeys.createdByIdpUuid })
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!key) {
      throw new NotFoundException('Widget key not found');
    }
    if (key.createdByIdpUuid !== adminUuid) {
      throw new ForbiddenException(
        'You do not have permission to view collaborators of this widget key',
      );
    }

    const rows = await this.db
      .select()
      .from(widgetKeyCollaborators)
      .where(eq(widgetKeyCollaborators.widgetKeyId, widgetKeyId));

    return rows.map((r) => ({
      id: r.id,
      inviteeEmail: r.inviteeEmail,
      role: r.role,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  async removeCollaborator(
    widgetKeyId: string,
    inviteeId: string,
    adminUuid: string,
  ): Promise<void> {
    const [key] = await this.db
      .select({ createdByIdpUuid: widgetKeys.createdByIdpUuid })
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!key) {
      throw new NotFoundException('Widget key not found');
    }
    if (key.createdByIdpUuid !== adminUuid) {
      throw new ForbiddenException(
        'You do not have permission to remove collaborators from this widget key',
      );
    }

    const [collaborator] = await this.db
      .select()
      .from(widgetKeyCollaborators)
      .where(
        and(
          eq(widgetKeyCollaborators.id, inviteeId),
          eq(widgetKeyCollaborators.widgetKeyId, widgetKeyId),
        ),
      )
      .limit(1);

    if (!collaborator) {
      throw new NotFoundException('Collaborator not found');
    }

    await this.db
      .delete(widgetKeyCollaborators)
      .where(eq(widgetKeyCollaborators.id, inviteeId));
  }
}
