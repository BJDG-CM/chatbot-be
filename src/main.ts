import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  const multipart = await import('@fastify/multipart').then((m) => m.default);

  await app.register(multipart, {
    limits: {
      fileSize: 1024 * 1024 * 20, // 20MB for PDF
      fieldNameSize: 256,
      fields: 10,
      files: 1,
    },
  });

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors) => {
        const messages = errors.map((error) =>
          Object.values(error.constraints || {}).join(', '),
        );
        return new BadRequestException({
          statusCode: 400,
          message: messages,
          error: 'Bad Request',
        });
      },
    }),
  );

  // Swagger 설정
  const config = new DocumentBuilder()
    .setTitle('Chat Widget Auth & History API')
    .setDescription(
      '채팅 위젯의 인증(Auth) 및 대화 내역 저장(History Storage)을 담당하는 백엔드 API',
    )
    .setVersion('1.3.1')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description: '관리자용 토큰 (Admin Dashboard)',
      },
      'bearerAuth',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: '위젯 세션 토큰 (Widget Client)',
      },
      'widgetSessionAuth',
    )
    .addTag('Widget Auth', '(Public) 위젯 초기화 및 세션 발급')
    .addTag('Widget Messages', '(Public) 대화 내역 저장 및 조회')
    .addTag('Admin Management', '(Private) 위젯 키 관리')
    .addTag('Authentication', '(Private) Admin 인증 및 토큰 관리')
    .addTag('Upload', '(Private) Super Admin 전용 PDF 업로드/삭제')
    .addTag('Health', '(Public) 서버 상태 확인')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // ConfigService를 통해 환경 변수 가져오기 (검증된 값)
  const configService = app.get(ConfigService);

  // Swagger API 문서 잠금: SWAGGER_USER/SWAGGER_PASSWORD 설정 시 Basic Auth 적용
  const swaggerUser = configService.get<string>('SWAGGER_USER');
  const swaggerPassword = configService.get<string>('SWAGGER_PASSWORD');
  if (swaggerUser && swaggerPassword) {
    const fastify = app.getHttpAdapter().getInstance();
    fastify.addHook('preHandler', async (request, reply) => {
      if (!request.url.startsWith('/api/docs')) return;
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Basic ')) {
        return reply
          .status(401)
          .header('WWW-Authenticate', 'Basic realm="Swagger API Docs"')
          .send({
            statusCode: 401,
            message: 'Swagger 문서 접근에는 인증이 필요합니다.',
          });
      }
      const encoded = authHeader.slice(6);
      let decoded: string;
      try {
        decoded = Buffer.from(encoded, 'base64').toString('utf8');
      } catch {
        return reply
          .status(401)
          .header('WWW-Authenticate', 'Basic realm="Swagger API Docs"')
          .send({ statusCode: 401, message: '잘못된 인증 정보입니다.' });
      }
      const colonIndex = decoded.indexOf(':');
      const user = colonIndex === -1 ? decoded : decoded.slice(0, colonIndex);
      const password = colonIndex === -1 ? '' : decoded.slice(colonIndex + 1);
      if (user !== swaggerUser || password !== swaggerPassword) {
        return reply
          .status(401)
          .header('WWW-Authenticate', 'Basic realm="Swagger API Docs"')
          .send({
            statusCode: 401,
            message: '사용자명 또는 비밀번호가 올바르지 않습니다.',
          });
      }
    });
  }
  const port = configService.get<number>('PORT', 3000);

  // CORS 설정
  app.enableCors({
    origin: [
      'http://localhost:5173',
      `https://${configService.get<string>('DOMAIN_NAME') ?? ''}`,
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Origin',
      'Content-Disposition',
    ],
  });

  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`Swagger documentation: http://localhost:${port}/api/docs`);
}
void bootstrap();
