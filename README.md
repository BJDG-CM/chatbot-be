<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

채팅 위젯의 **인증(Auth)** 및 **대화 내역 저장(History Storage)**을 담당하는 백엔드 API입니다.

## Tech Stack

- **Runtime**: Bun
- **Framework**: NestJS + Fastify
- **Database**: PostgreSQL
- **ORM**: Drizzle ORM

## Project setup

```bash
# 패키지 설치
$ bun install

# 환경 변수 설정
$ cp .env.example .env
# .env 파일을 열어서 데이터베이스 정보를 입력하세요
```

## Patched dependencies

- **@modelcontextprotocol/sdk**: MCP Client와 Server 간 **단일 연결**을 유지하기 위해, SDK의 `ping` 메서드가 서버로 요청을 보내지 않도록 patch-package로 비활성화되어 있습니다. (`patches/@modelcontextprotocol+sdk+1.25.2.patch`)
- `bun install` 시 `postinstall` 스크립트가 자동으로 패치를 적용합니다.
- **@modelcontextprotocol/sdk 버전을 올릴 때**: `patches/` 의 패치가 새 버전에 그대로 적용되지 않을 수 있습니다. 버전 업 후 `bun run build` 또는 MCP 연동 테스트로 동작을 확인하고, 필요하면 패치를 수정한 뒤 `bun install --yarn` 후 `npx patch-package @modelcontextprotocol/sdk` 로 패치 파일을 재생성하세요.

## Environment Variables

`.env` 파일에 다음 환경 변수를 설정하세요:

```env
# Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=ziggle_chatbot
DB_SSL=false

# Application
PORT=3000
NODE_ENV=development

# JWT (세션 토큰용)
# 보안 요구사항: 최소 32자 이상의 강력한 시크릿 키 필요
# 프로덕션에서는 반드시 안전한 랜덤 문자열로 변경하세요
# 생성 방법: openssl rand -base64 32
JWT_SECRET=your-secret-key-here-change-in-production-min-32-chars
JWT_EXPIRES_IN=3600

# Infoteam IDP Configuration (Admin 인증용)
IDP_URL=https://api.account.gistory.me
IDP_CLIENT_ID=your_client_id
IDP_CLIENT_SECRET=your_client_secret

# Admin Authentication (Legacy - Optional, 더 이상 사용되지 않음)
# ADMIN_BEARER_TOKEN=your-admin-token-here-change-in-production-min-16-chars
```

**안전한 시크릿 생성 방법:**

```bash
# JWT Secret 생성 (최소 32자)
openssl rand -base64 32
```

**Admin 인증 변경사항:**

- 기존의 `ADMIN_BEARER_TOKEN` 방식에서 **Infoteam IDP OAuth 2.0** 인증으로 변경되었습니다.
- Admin API 접근 시 `@gistory.me` 이메일로 IDP 인증이 필요합니다.
- 자세한 마이그레이션 가이드는 [ADMIN_IDP_MIGRATION.md](./ADMIN_IDP_MIGRATION.md)를 참고하세요.

## Database Setup

### 로컬 개발 환경

```bash
# PostgreSQL이 설치되어 있어야 합니다
# 데이터베이스 생성
$ psql -U postgres -c "CREATE DATABASE ziggle_chatbot;"

# 마이그레이션 파일 생성 (스키마 변경 시)
$ bun run db:generate

# 스키마를 데이터베이스에 적용 (개발 환경용 - 빠른 동기화)
$ bun run db:push

# 또는 마이그레이션 실행 (프로덕션과 동일한 방식)
$ bun run db:migrate

# Drizzle Studio 실행 (데이터베이스 GUI)
$ bun run db:studio
```

### Docker 환경

**Docker는 로컬의 `.env` 파일을 자동으로 읽습니다.**

- `DB_HOST`는 자동으로 `postgres`로 오버라이드 (Docker 네트워크용)
- `NODE_ENV`는 자동으로 `production`으로 오버라이드
- 나머지 값들은 `.env` 파일에서 그대로 사용됩니다

```bash
# .env 파일이 있는지 확인
$ ls -la .env

# Docker Compose로 PostgreSQL + 애플리케이션 실행
$ docker-compose up -d

# 로그 확인
$ docker-compose logs -f app

# 서비스 중지
$ docker-compose down

# 데이터베이스 포함 전체 삭제
$ docker-compose down -v
```

### Docker 마이그레이션 수동 실행

```bash
# 애플리케이션 컨테이너에서 마이그레이션 실행 (권장)
$ docker-compose exec app bun run db:migrate

# 또는 안전한 마이그레이션 스크립트 사용
$ docker-compose exec app bun run db:migrate:safe

# 마이그레이션 파일 생성 (스키마 변경 시)
$ docker-compose exec app bun run db:generate

# Drizzle Studio 실행 (로컬에서 Docker DB 접속)
$ bun run db:studio
```

### 프로덕션 서버 마이그레이션

서버에 배포할 때는 다음 명령어로 마이그레이션을 실행하세요:

```bash
# 안전한 마이그레이션 실행 (권장)
$ bun run db:migrate:safe

# 또는 직접 실행
$ bun run db:migrate
```

**중요 사항:**

- 모든 마이그레이션 파일은 **idempotent**하게 작성되어 있어 여러 번 실행해도 안전합니다.
- ENUM 타입, 테이블, 인덱스, 제약조건은 이미 존재하면 자동으로 건너뜁니다.
- 서버의 데이터베이스가 로컬 개발 환경과 동일한 구조로 동기화됩니다.

## Compile and run the project

### 로컬 환경

```bash
# development
$ bun run start

# watch mode
$ bun run start:dev

# production mode
$ bun run start:prod
```

### Docker 환경

```bash
# 개발 모드 (docker-compose.yml 수정 필요)
$ docker-compose up

# 백그라운드 실행
$ docker-compose up -d

# 프로덕션 빌드
$ docker build -t ziggle-chatbot-be .
$ docker run -p 3000:3000 --env-file .env ziggle-chatbot-be
```

서버 실행 후 다음 URL에서 확인할 수 있습니다:

- **API**: http://localhost:3000
- **Swagger 문서**: http://localhost:3000/api/docs

## API 엔드포인트

### 1. Widget Auth (Public)

- `POST /api/v1/widget/auth/session` - 위젯 세션 토큰 발급

### 2. Widget Messages (Public, 인증 필요)

- `GET /api/v1/widget/messages` - 대화 내역 조회 (커서 기반 페이징)
- `POST /api/v1/widget/messages` - 대화 메시지 저장

### 3. Admin Management (Private, IDP 인증 필요)

- `GET /api/v1/admin/widget-keys` - 위젯 키 목록 조회
- `POST /api/v1/admin/widget-keys` - 위젯 키 생성
- `PATCH /api/v1/admin/widget-keys/:widgetKeyId/revoke` - 위젯 키 폐기

**인증 방식:** Infoteam IDP OAuth 2.0 (`@gistory.me` 이메일 필수)

자세한 API 스펙은 Swagger 문서를 참고하세요.

## 테스트

### 유닛 테스트

```bash
# 모든 유닛 테스트 실행
$ bun test

# watch 모드
$ bun run test:watch

# 커버리지 확인
$ bun run test:cov

# 특정 파일만 테스트
$ bun test src/admin/admin.service.spec.ts
```

### E2E 테스트

```bash
# E2E 테스트 실행
$ bun run test:e2e

# 모든 테스트 실행 (unit + e2e)
$ bun run test:all
```

### 테스트 커버리지

```bash
# 커버리지 리포트 생성
$ bun run test:cov

# coverage/ 폴더에 HTML 리포트 생성됨
$ open coverage/lcov-report/index.html
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
