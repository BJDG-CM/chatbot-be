import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DB_CONNECTION, type Database, widgetKeys, sessions } from '../db';
import { eq } from 'drizzle-orm';
import {
  extractDomain,
  isDomainAllowed,
} from '../common/utils/domain-validator.util';
import { WidgetSessionRequestDto } from '../common/dto/widget-session-request.dto';
import { WidgetSessionResponseDto } from '../common/dto/widget-session-response.dto';

@Injectable()
export class WidgetAuthService {
  constructor(
    @Inject(DB_CONNECTION) private db: Database,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async createSession(
    dto: WidgetSessionRequestDto,
  ): Promise<WidgetSessionResponseDto> {
    // 1. pageUrl에서 도메인 추출
    const domain = extractDomain(dto.pageUrl);
    if (!domain) {
      throw new BadRequestException('Invalid pageUrl: cannot extract domain');
    }

    // 2. widgetKey로 DB 조회
    const [widgetKey] = await this.db
      .select()
      .from(widgetKeys)
      .where(eq(widgetKeys.secretKey, dto.widgetKey))
      .limit(1);

    if (!widgetKey) {
      throw new NotFoundException('Widget key not found');
    }

    // 3. REVOKED 상태 확인
    if (widgetKey.status === 'REVOKED') {
      throw new ForbiddenException('Widget key has been revoked');
    }

    // 4. 도메인 검증
    const allowedDomains = widgetKey.allowedDomains || [];
    if (!isDomainAllowed(domain, allowedDomains)) {
      throw new ForbiddenException('Domain not allowed for this widget key');
    }

    // 5. 세션 생성 및 DB 저장
    const expiresInSeconds = 1800; // 30분
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    const [newSession] = await this.db
      .insert(sessions)
      .values({
        widgetKeyId: widgetKey.id,
        sessionToken: '', // 임시값, 아래에서 JWT 생성 후 업데이트
        pageUrl: dto.pageUrl,
        expiresAt,
      })
      .returning();

    // 6. JWT 토큰 생성
    const payload = {
      sessionId: newSession.id,
      widgetKeyId: widgetKey.id,
    };
    const sessionToken = await this.jwtService.signAsync(payload);

    // 7. 세션에 토큰 저장
    await this.db
      .update(sessions)
      .set({ sessionToken })
      .where(eq(sessions.id, newSession.id));

    // 8. 응답 반환
    return {
      sessionToken,
      expiresIn: expiresInSeconds,
    };
  }
}
