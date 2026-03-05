# Bun을 사용하는 Dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# 의존성 설치 단계 (postinstall에서 patch-package가 patches/ 적용)
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
COPY patches /temp/dev/patches/
RUN cd /temp/dev && bun install --frozen-lockfile

# 프로덕션 의존성만 설치 (postinstall에서 patch-package가 patches/ 적용)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
COPY patches /temp/prod/patches/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# 빌드 단계
FROM base AS build
COPY --from=install /temp/dev/node_modules node_modules
COPY . .
RUN bun run build

# 프로덕션 단계
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/libs libs
COPY --from=build /app/drizzle drizzle
COPY --from=build /app/drizzle.config.ts .
COPY --from=build /app/package.json .
COPY --from=build /app/tsconfig.json .
COPY --from=build /app/scripts scripts

# 스크립트 실행 권한 부여
RUN chmod +x /app/scripts/start.sh

# 포트 노출
EXPOSE 3000

# 애플리케이션 실행 (migration 후 start)
CMD ["/app/scripts/start.sh"]
