# Infoteam IDP Module

Infoteam Identity Provider (IDP) 인증을 위한 NestJS 모듈입니다.

## 기능

- Infoteam IDP를 통한 OAuth 2.0 인증
- Access Token 검증
- ID Token 검증
- 사용자 정보 조회
- Client Credentials Grant를 통한 서버 간 인증

## 설치

이 모듈은 chatbot-be 프로젝트의 내부 라이브러리입니다.

필요한 의존성

- `@nestjs/axios`
- `axios`
- `@nestjs/jwt`
- `@nestjs/config`

## 환경 변수 설정

`.env` 파일에 다음 환경 변수를 추가하세요:

```env
# Infoteam IDP Configuration
IDP_URL=https://api.account.gistory.me
IDP_CLIENT_ID=your_client_id
IDP_CLIENT_SECRET=your_client_secret
```

## 사용 방법

### 1. 모듈 Import

```typescript
import { InfoteamIdpModule } from '@lib/infoteam-idp';

@Module({
  imports: [InfoteamIdpModule],
})
export class YourModule {}
```

### 2. Service 사용

```typescript
import { InfoteamIdpService } from '@lib/infoteam-idp';

@Injectable()
export class YourService {
  constructor(private readonly idpService: InfoteamIdpService) {}

  async validateUser(accessToken: string) {
    const userInfo = await this.idpService.validateAccessToken(accessToken);
    return userInfo;
  }
}
```

### 3. Admin 인증 Guard 사용

Admin Management API에서 IDP 인증을 사용하려면:

```typescript
import { AdminIdpGuard } from '../auth/guards/admin-idp.guard';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import { AdminContext } from '../auth/context/admin-context.entity';

@Controller('api/v1/admin')
@UseGuards(AdminIdpGuard)
export class AdminController {
  @Get('some-endpoint')
  async someMethod(@CurrentAdmin() admin: AdminContext) {
    // admin.email, admin.uuid, admin.name 사용 가능
    console.log(`Admin: ${admin.email}`);
  }
}
```

## API

### InfoteamIdpService

#### validateAccessToken(accessToken: string): Promise<UserInfo>

Access Token을 검증하고 사용자 정보를 반환합니다.

```typescript
const userInfo = await idpService.validateAccessToken(token);
// { uuid, name, email, picture, profile, studentId }
```

#### validateIdToken(idToken: string): Promise<UserInfo | null>

ID Token을 검증하고 사용자 정보를 반환합니다.

```typescript
const userInfo = await idpService.validateIdToken(idToken);
```

#### getUserInfo(userUuid: string): Promise<UserInfo | null>

Client Access Token을 사용하여 특정 사용자의 정보를 조회합니다.

```typescript
const userInfo = await idpService.getUserInfo('user-uuid');
```

## 타입

### UserInfo

```typescript
type UserInfo = {
  uuid: string;
  profile: string;
  picture: string;
  name: string;
  email: string;
  studentId: string;
};
```

### AdminContext

```typescript
class AdminContext {
  email: string;
  uuid: string;
  name: string;
}
```

## 보안

- Admin 인증은 `@gistory.me` 이메일 도메인만 허용합니다.
- Access Token은 IDP 서버에서 직접 검증됩니다.
- Client Credentials는 자동으로 갱신됩니다.

## 참고

이 모듈은 potg-be의 infoteam-idp 라이브러리를 기반으로 작성되었습니다.
