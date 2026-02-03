import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
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

/** list_resources 호출 결과 (캐시용) */
export type ListResourcesResult = {
  raw: unknown;
  texts: string[];
  resourceLinks: unknown[];
  embeddedResources: unknown[];
  filteredResources: Array<{ path: string; formats: string[] }>;
};

/**
 * MCP Client Service
 * MCP 서버와의 연결 및 Tool 호출을 관리합니다.
 */
@Injectable()
export class McpClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);

  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  /** list_resources 결과 캐시 (리소스 목록은 자주 바뀌지 않음) */
  private cachedListResources: {
    argsKey: string;
    result: ListResourcesResult;
    timestamp: number;
  } | null = null;
  private readonly LIST_RESOURCES_CACHE_TTL = 5 * 60 * 1000; // 5분

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const baseUrl = this.config.get<string>('MCP_BASE_URL');
    if (!baseUrl) {
      this.logger.warn(
        'MCP_BASE_URL is not set, MCP client will not be initialized',
      );
      return;
    }

    try {
      // Client 생성
      this.client = new Client(
        { name: 'Ziggle Chatbot MCP Client', version: '1.0.0' },
        {
          capabilities: {},
        },
      );

      this.client.onerror = (err) => {
        const errorMessage = String(err);
        // SSE stream disconnected는 정상적인 연결 종료일 수 있으므로 debug 레벨로 처리
        if (
          errorMessage.includes('SSE stream disconnected') ||
          errorMessage.includes('terminated')
        ) {
          this.logger.debug(`MCP client connection closed: ${errorMessage}`);
        } else {
          this.logger.error(`MCP client error: ${errorMessage}`);
        }
      };

      // Transport 생성 및 연결
      this.transport = new StreamableHTTPClientTransport(new URL(baseUrl));
      this.attachNotificationHandlers(this.client);

      await this.client.connect(this.transport);

      this.logger.log(
        `Connected to MCP server: ${baseUrl} (sessionId=${this.transport.sessionId ?? 'none'})`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to initialize MCP client: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async onModuleDestroy() {
    try {
      await this.transport?.close();
    } catch (e) {
      this.logger.warn(`Transport close failed: ${String(e)}`);
    }

    try {
      await this.client?.close();
    } catch (e) {
      this.logger.warn(`Client close failed: ${String(e)}`);
    }

    this.transport = null;
    this.client = null;
  }

  private attachNotificationHandlers(client: Client) {
    // 서버가 로그/이벤트를 보내는 경우 NestJS 로그로 흡수
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

  private getConnectedClient(): Client {
    if (!this.client || !this.transport) {
      throw new Error('MCP client is not connected');
    }
    return this.client;
  }

  /**
   * Tool 목록 조회
   * @returns Tool 목록
   */
  async listTools() {
    const client = this.getConnectedClient();

    const req: ListToolsRequest = { method: 'tools/list', params: {} };
    const res = await client.request(req, ListToolsResultSchema);

    return res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * list_resources 응답 파싱 (캐시 저장 및 일반 호출 경로에서 공통 사용)
   */
  private parseListResourcesResponse(res: {
    content: Array<{ type: string; text?: string }>;
  }): ListResourcesResult {
    const texts: string[] = [];
    const resourceLinks: unknown[] = [];
    const embeddedResources: unknown[] = [];
    const filteredResources: Array<{ path: string; formats: string[] }> = [];

    for (const item of res.content) {
      if (item.type === 'text') {
        const text = item.text ?? '';
        try {
          const parsed = JSON.parse(text);
          if (parsed.resources && Array.isArray(parsed.resources)) {
            // 경로 선별·본문 fetch용: md 포함 리소스 필요 (png/pdf만 있으면 md 전용 문서가 빠져 LLM이 선택할 문서 없음)
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

    const client = this.getConnectedClient();

    const req: CallToolRequest = {
      method: 'tools/call',
      params: { name, arguments: args },
    };

    const res = await client.request(req, CallToolResultSchema);

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
