import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  LoggingMessageNotificationSchema,
  ResourceListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type {
  ListToolsRequest,
  CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';

/** list_resources 신 형식: 상위 리소스 (description + chunks) */
export type ListResourceItem = {
  path: string;
  description: string;
  chunks: Array<{ path: string; description: string }>;
};

/** list_resources 호출 결과 (캐시용) */
export type ListResourcesResult = {
  raw: unknown;
  texts: string[];
  resourceLinks: unknown[];
  embeddedResources: unknown[];
  /** 구 형식: 플랫 리스트 (경로 + formats) */
  filteredResources: Array<{ path: string; formats: string[] }>;
  /** 신 형식: 상위 리소스 목록 (path, description, chunks) */
  resources?: ListResourceItem[];
  /** 신 형식: 모든 chunk 평탄화 - LLM 선별용 */
  chunks?: Array<{ path: string; description: string }>;
  /** 신 형식: 상위 리소스 개수 */
  total?: number;
};

/**
 * MCP Client Service
 * 질문/요청 시에만 MCP 서버에 연결하고, 사용 후 연결을 닫습니다.
 * 상시 연결을 유지하지 않아 5분 타임아웃·요청 누적 문제를 방지합니다.
 */
@Injectable()
export class McpClientService implements OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);

  /** list_resources 결과 캐시 (리소스 목록은 자주 바뀌지 않음) */
  private cachedListResources: {
    argsKey: string;
    result: ListResourcesResult;
    timestamp: number;
  } | null = null;
  private readonly LIST_RESOURCES_CACHE_TTL = 5 * 60 * 1000; // 5분

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy() {
    // 상시 연결 없음 — 정리할 리소스 없음
  }

  private getBaseUrl(): string {
    const baseUrl = this.config.get<string>('MCP_BASE_URL');
    if (!baseUrl) {
      throw new Error('MCP_BASE_URL is not set');
    }
    return baseUrl;
  }

  /**
   * 요청 시에만 연결하여 fn(client) 실행 후 반드시 연결을 닫습니다.
   */
  private async runWithConnection<T>(
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const baseUrl = this.getBaseUrl();
    const client = new Client(
      { name: 'GIST Chatbot MCP Client', version: '1.0.0' },
      { capabilities: {} },
    );

    client.onerror = (err) => {
      const msg = String(err);
      if (
        msg.includes('SSE stream disconnected') ||
        msg.includes('terminated')
      ) {
        this.logger.debug(`MCP connection closed: ${msg}`);
      } else {
        this.logger.error(`MCP client error: ${msg}`);
      }
    };

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    this.attachNotificationHandlers(client);

    try {
      await client.connect(transport);
      this.logger.debug(
        `MCP connected: ${baseUrl} (sessionId=${transport.sessionId ?? 'none'})`,
      );
      return await fn(client);
    } finally {
      try {
        await transport.close();
      } catch (e) {
        this.logger.warn(`Transport close failed: ${String(e)}`);
      }
      try {
        await client.close();
      } catch (e) {
        this.logger.warn(`Client close failed: ${String(e)}`);
      }
    }
  }

  private attachNotificationHandlers(client: Client) {
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      this.logger.log(
        `[MCP:${n.params.level}] ${typeof n.params.data === 'string' ? n.params.data : JSON.stringify(n.params.data)}`,
      );
    });

    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      this.logger.debug(
        'Resource list changed (notification), invalidating list_resources cache',
      );
      this.cachedListResources = null;
    });
  }

  /**
   * Tool 목록 조회 (요청 시 연결, 완료 후 연결 종료)
   */
  async listTools() {
    return this.runWithConnection(async (client) => {
      const req: ListToolsRequest = { method: 'tools/list', params: {} };
      const res = await client.request(req, ListToolsResultSchema);
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    });
  }

  /**
   * list_resources 응답 파싱 (캐시 저장 및 일반 호출 경로에서 공통 사용)
   * 신 형식: { resources: [{ path, description, chunks }], total } → chunks 평탄화
   * 구 형식: { resources: [{ path, formats }] } → filteredResources
   */
  private parseListResourcesResponse(res: {
    content: Array<{ type: string; text?: string }>;
  }): ListResourcesResult {
    const texts: string[] = [];
    const resourceLinks: unknown[] = [];
    const embeddedResources: unknown[] = [];
    let filteredResources: Array<{ path: string; formats: string[] }> = [];
    let resources: ListResourceItem[] | undefined;
    let chunks: Array<{ path: string; description: string }> | undefined;
    let total: number | undefined;

    for (const item of res.content) {
      if (item.type === 'text') {
        const text = item.text ?? '';
        try {
          const parsed = JSON.parse(text);
          if (parsed.resources && Array.isArray(parsed.resources)) {
            const first = parsed.resources[0];
            const isNewFormat =
              first &&
              typeof first.description === 'string' &&
              Array.isArray(first.chunks);

            if (isNewFormat) {
              resources = parsed.resources as ListResourceItem[];
              total =
                typeof parsed.total === 'number'
                  ? parsed.total
                  : resources.length;
              chunks = resources.flatMap((r) =>
                (r.chunks || []).map((c) => ({
                  path: c.path,
                  description: c.description || '',
                })),
              );
            } else {
              const withMdOrPdfPng = parsed.resources.filter(
                (resource: { path: string; formats: string[] }) =>
                  resource.formats &&
                  Array.isArray(resource.formats) &&
                  (resource.formats.includes('md') ||
                    resource.formats.includes('png') ||
                    resource.formats.includes('pdf')),
              );
              filteredResources = withMdOrPdfPng;
            }
          } else {
            texts.push(text);
          }
        } catch {
          texts.push(text);
        }
        continue;
      }
      if (item.type === 'resource_link') {
        resourceLinks.push(item);
        continue;
      }
      if (item.type === 'resource') {
        embeddedResources.push(item);
        continue;
      }
    }

    return {
      raw: res,
      texts,
      resourceLinks,
      embeddedResources,
      filteredResources,
      resources,
      chunks,
      total,
    };
  }

  /**
   * Tool 호출
   * @param name Tool 이름
   * @param args Tool 인자
   * @returns Tool 실행 결과 (raw 응답 포함)
   */
  async callTool<
    TArgs extends Record<string, unknown> = Record<string, unknown>,
  >(name: string, args: TArgs) {
    // list_resources는 자주 바뀌지 않으므로 캐시 사용
    if (name === 'list_resources') {
      const argsKey = JSON.stringify(args ?? {});
      const now = Date.now();
      if (
        this.cachedListResources &&
        this.cachedListResources.argsKey === argsKey &&
        now - this.cachedListResources.timestamp < this.LIST_RESOURCES_CACHE_TTL
      ) {
        this.logger.debug('Using cached list_resources result');
        return this.cachedListResources.result;
      }
    }

    const res = await this.runWithConnection(async (client) => {
      const req: CallToolRequest = {
        method: 'tools/call',
        params: { name, arguments: args },
      };
      return client.request(req, CallToolResultSchema);
    });

    // list_resources는 동일 파싱 로직으로 처리 후 캐시
    if (name === 'list_resources') {
      const result = this.parseListResourcesResponse(
        res as { content: Array<{ type: string; text?: string }> },
      );
      const argsKey = JSON.stringify(args ?? {});
      this.cachedListResources = {
        argsKey,
        result,
        timestamp: Date.now(),
      };
      return result;
    }

    // 그 외 Tool: 기존 파싱
    const texts: string[] = [];
    const resourceLinks: any[] = [];
    const embeddedResources: any[] = [];
    const filteredResources: Array<{ path: string; formats: string[] }> = [];

    for (const item of res.content) {
      if (item.type === 'text') {
        try {
          const parsed = JSON.parse(item.text);
          if (parsed.resources && Array.isArray(parsed.resources)) {
            const withMdOrPdfPng = parsed.resources.filter(
              (resource: { path: string; formats: string[] }) =>
                resource.formats &&
                Array.isArray(resource.formats) &&
                (resource.formats.includes('md') ||
                  resource.formats.includes('png') ||
                  resource.formats.includes('pdf')),
            );
            filteredResources.push(...withMdOrPdfPng);
          } else {
            texts.push(item.text);
          }
        } catch {
          texts.push(item.text);
        }
        continue;
      }
      if (item.type === 'resource_link') {
        resourceLinks.push(item);
        continue;
      }
      if (item.type === 'resource') {
        embeddedResources.push(item);
        continue;
      }
    }

    return {
      raw: res,
      texts,
      resourceLinks,
      embeddedResources,
      filteredResources,
    };
  }
}
