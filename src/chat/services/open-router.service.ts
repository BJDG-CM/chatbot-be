import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AxiosError } from 'axios';
import type { Readable } from 'stream';
import { inspect } from 'node:util';
import type {
  McpTool,
  OpenRouterTool,
  OpenRouterMessage,
  OpenRouterRequest,
  OpenRouterResponse,
  ParsedToolCall,
} from '../types/open-router.types';
import { getToolSelectionSystemPrompt } from '../prompts';

/**
 * Open Router 서비스
 * LLM을 통해 MCP Tool 선택 및 실행을 관리합니다.
 */
/** Open Router 모델 용도 */
export type OpenRouterModelType = 'light' | 'normal' | 'heavy';

@Injectable()
export class OpenRouterService {
  private readonly logger = new Logger(OpenRouterService.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://openrouter.ai/api/v1';
  private readonly modelLight: string;
  private readonly modelNormal: string;
  private readonly modelHeavy: string;
  private readonly defaultModel: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.apiKey = this.configService.getOrThrow<string>('OPEN_ROUTER_API_KEY');
    const fallback =
      this.configService.get<string>('OPEN_ROUTER_MODEL') ||
      'anthropic/claude-3.5-sonnet';
    this.modelLight =
      this.configService.get<string>('OPEN_ROUTER_MODEL_LIGHT') || fallback;
    this.modelNormal =
      this.configService.get<string>('OPEN_ROUTER_MODEL_NORMAL') || fallback;
    this.modelHeavy =
      this.configService.get<string>('OPEN_ROUTER_MODEL_HEAVY') || fallback;
    this.defaultModel = this.modelNormal;
  }

  /** 용도별 모델 반환 (light: 선별, normal: 단순 응답, heavy: 최종 답변) */
  getModel(type: OpenRouterModelType): string {
    switch (type) {
      case 'light':
        return this.modelLight;
      case 'normal':
        return this.modelNormal;
      case 'heavy':
        return this.modelHeavy;
      default:
        return this.defaultModel;
    }
  }

  /**
   * MCP Tool 목록을 Open Router Function Calling 형식으로 변환
   */
  convertMcpToolsToOpenRouterFormat(mcpTools: McpTool[]): OpenRouterTool[] {
    return mcpTools.map((tool) => {
      const parameters = tool.inputSchema || {
        type: 'object',
        properties: {},
        required: [],
      };

      // Tool description 개선: 더 상세한 설명 생성
      let description = tool.description || '';

      // Description이 없거나 너무 짧은 경우 개선
      if (!description || description.trim().length < 20) {
        // Tool 이름을 기반으로 더 상세한 설명 생성
        const toolNameLower = tool.name.toLowerCase();
        const paramInfo = parameters.properties
          ? Object.keys(parameters.properties)
              .map((key) => {
                const prop = parameters.properties![key];
                return `${key} (${prop.type || 'string'})`;
              })
              .join(', ')
          : 'no parameters';

        description = `Tool: ${tool.name}. 
Use this tool when the user's question relates to ${tool.name} or when you need to access information related to ${toolNameLower}.
${paramInfo ? `Parameters: ${paramInfo}` : 'No parameters required.'}
This tool is essential for answering questions that require ${toolNameLower} functionality.`;
      } else {
        // 기존 description이 있으면 파라미터 정보 추가
        const paramInfo = parameters.properties
          ? Object.keys(parameters.properties)
              .map((key) => {
                const prop = parameters.properties![key];
                return `${key} (${prop.type || 'string'})`;
              })
              .join(', ')
          : '';

        if (paramInfo) {
          description += ` Parameters: ${paramInfo}.`;
        }
      }

      return {
        type: 'function',
        function: {
          name: tool.name,
          description: description.trim(),
          parameters: {
            type: parameters.type || 'object',
            properties: parameters.properties || {},
            required: parameters.required || [],
          },
        },
      };
    });
  }

  /**
   * 사용자 질문과 MCP Tool 목록을 기반으로 LLM에게 Tool 선택 요청
   * @param userQuestion 사용자 질문
   * @param mcpTools 사용 가능한 MCP Tool 목록
   * @param model 사용할 LLM 모델 (선택사항)
   * @param options 추가 옵션 (temperature, emphasizeToolUsage 등)
   * @param pastMessages 과거 대화 (시간순, user/assistant만) — context 유지용
   * @returns LLM 응답 (tool_calls 포함 가능)
   */
  async selectTool(
    userQuestion: string,
    mcpTools: McpTool[],
    model?: string,
    options?: {
      temperature?: number;
      emphasizeToolUsage?: boolean;
    },
    pastMessages?: OpenRouterMessage[],
  ): Promise<OpenRouterResponse> {
    const tools = this.convertMcpToolsToOpenRouterFormat(mcpTools);

    // Tool 목록을 더 읽기 쉽게 포맷팅
    const toolsDescription = mcpTools
      .map((tool, index) => {
        const toolInfo = tools[index];
        const params = toolInfo.function.parameters.properties
          ? Object.entries(toolInfo.function.parameters.properties)
              .map(([key, value]: [string, any]) => {
                const type = value.type || 'string';
                const desc = value.description ? ` - ${value.description}` : '';
                return `  - ${key} (${type})${desc}`;
              })
              .join('\n')
          : '  (no parameters)';

        return `${index + 1}. ${tool.name}
   Description: ${toolInfo.function.description}
   Parameters:
${params}`;
      })
      .join('\n\n');

    // System prompt 강화
    const systemPrompt = getToolSelectionSystemPrompt({
      toolsDescription,
      emphasizeToolUsage: options?.emphasizeToolUsage,
    });

    const messages: OpenRouterMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(pastMessages ?? []),
      { role: 'user', content: userQuestion },
    ];

    const request: OpenRouterRequest = {
      model: model || this.defaultModel,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: options?.temperature ?? 0.3, // 재시도 시 더 낮은 temperature 사용 가능
      max_tokens: 2000,
    };

    const requestLogSummary = {
      model: request.model,
      stream: false,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      messages: this.summarizeOpenRouterMessages(messages),
      toolsCount: tools.length,
    };

    try {
      const response = await firstValueFrom(
        this.httpService
          .post<OpenRouterResponse>(
            `${this.baseUrl}/chat/completions`,
            request,
            {
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': this.configService.get<string>('DOMAIN_NAME'),
                'X-Title': this.configService.get<string>('OPEN_ROUTER_TITLE'),
              },
              timeout: 15000,
            },
          )
          .pipe(
            catchError((error: AxiosError) => {
              const responseData = error.response?.data;
              this.logger.error(
                `Open Router API error: ${error.message}`,
                error instanceof Error ? error.stack : undefined,
              );
              if (responseData != null) {
                this.logger.error(
                  `Open Router error response body: ${this.safeStringify(responseData)}`,
                );
              }
              this.logger.error(
                `Open Router request summary: ${this.safeStringify(requestLogSummary)}`,
              );
              throw new InternalServerErrorException(
                `Failed to call Open Router API: ${error.message}`,
              );
            }),
          ),
      );

      // Tool 선택 응답 상세 로깅
      const responseData = response.data;
      const finishReason = responseData.choices[0]?.finish_reason;
      const hasToolCalls = !!responseData.choices[0]?.message.tool_calls;
      const toolCallCount =
        responseData.choices[0]?.message.tool_calls?.length || 0;

      // Tool이 선택되지 않은 경우 경고
      if (!hasToolCalls || toolCallCount === 0) {
        this.logger.warn(
          `No tools selected. Finish reason: ${finishReason}, Available tools: ${mcpTools.map((t) => t.name).join(', ')}`,
        );
      }

      return responseData;
    } catch (error) {
      this.logger.error(`Error calling Open Router: ${error}`);
      throw error;
    }
  }

  /**
   * LLM 응답에서 tool_calls 파싱
   */
  parseToolCalls(response: OpenRouterResponse): ParsedToolCall[] {
    const toolCalls: ParsedToolCall[] = [];

    for (const choice of response.choices) {
      if (choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          try {
            const args = JSON.parse(toolCall.function.arguments);
            toolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: args,
            });
          } catch (error) {
            this.logger.warn(
              `Failed to parse tool call arguments: ${toolCall.function.arguments}`,
              error,
            );
          }
        }
      }
    }

    return toolCalls;
  }

  private safeStringify(value: unknown, maxLen: number = 2000): string {
    try {
      if (typeof value === 'string') {
        return value.length > maxLen
          ? value.slice(0, maxLen) + '...(truncated)'
          : value;
      }

      // Buffer는 JSON.stringify하면 {}처럼 찍히기 쉬워 text로 변환합니다.
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value as Buffer)) {
        const str = (value as Buffer).toString('utf8');
        return str.length > maxLen
          ? str.slice(0, maxLen) + '...(truncated)'
          : str;
      }

      const str = JSON.stringify(value, null, 2);
      return str.length > maxLen
        ? str.slice(0, maxLen) + '...(truncated)'
        : str;
    } catch {
      const str = inspect(value, {
        depth: 5,
        maxArrayLength: 50,
        breakLength: 120,
      });
      return str.length > maxLen
        ? str.slice(0, maxLen) + '...(truncated)'
        : str;
    }
  }

  private summarizeOpenRouterMessages(messages: OpenRouterMessage[]) {
    const roleCounts: Record<string, number> = {};
    let assistantToolCalls = 0;
    let toolRoleMessages = 0;
    let toolRoleHasNameField = 0;
    let contentNullCount = 0;
    let contentCharsSum = 0;

    for (const m of messages) {
      roleCounts[m.role] = (roleCounts[m.role] ?? 0) + 1;
      if (m.role === 'assistant' && m.tool_calls?.length) {
        assistantToolCalls += m.tool_calls.length;
      }
      if (m.role === 'tool') {
        toolRoleMessages += 1;
        // 일부 모델/프로바이더에서 role=tool 메시지의 name 필드가 스키마에 없을 수 있음
        if ((m as unknown as { name?: unknown }).name != null) {
          toolRoleHasNameField += 1;
        }
      }
      if (m.content === null) contentNullCount += 1;
      if (typeof m.content === 'string') contentCharsSum += m.content.length;
    }

    return {
      total: messages.length,
      roleCounts,
      assistantToolCalls,
      toolRoleMessages,
      toolRoleHasNameField,
      contentNullCount,
      contentCharsSum,
    };
  }

  /**
   * Tool 실행 결과를 LLM에 전달하여 최종 응답을 스트리밍으로 생성
   * @param messages 이전 대화 내역
   * @param toolResults Tool 실행 결과 (tool_call_id와 결과 매핑)
   * @param model 사용할 LLM 모델 (선택사항)
   * @returns 스트리밍 응답 스트림
   */
  async generateFinalResponseStream(
    messages: OpenRouterMessage[],
    toolResults: Array<{
      tool_call_id: string;
      name: string;
      content: string;
    }>,
    model?: string,
    options?: { temperature?: number },
  ): Promise<Readable> {
    // Tool 결과를 메시지에 추가
    const toolMessages: OpenRouterMessage[] = toolResults.map((result) => ({
      role: 'tool',
      tool_call_id: result.tool_call_id,
      name: result.name,
      content: result.content,
    }));

    const updatedMessages = [...messages, ...toolMessages];

    const request: OpenRouterRequest & { stream: boolean } = {
      model: model || this.defaultModel,
      messages: updatedMessages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: 2000,
      stream: true,
      stream_options: { include_usage: true },
    };

    const requestLogSummary = {
      model: request.model,
      stream: request.stream,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      toolResultsCount: toolResults.length,
      toolResultsContentCharsSum: toolResults.reduce(
        (sum, r) => sum + (r.content?.length ?? 0),
        0,
      ),
      messages: this.summarizeOpenRouterMessages(updatedMessages),
    };

    try {
      const response = await firstValueFrom(
        this.httpService
          .post<Readable>(`${this.baseUrl}/chat/completions`, request, {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': this.configService.get<string>('DOMAIN_NAME'),
              'X-Title': this.configService.get<string>('APP_NAME'),
            },
            responseType: 'stream',
            timeout: 15000,
          })
          .pipe(
            catchError((error: AxiosError) => {
              const errorMessage = error.message;
              const statusCode = error.response?.status;
              const responseData = error.response?.data;
              this.logger.error(
                `Open Router API error (status ${statusCode}): ${errorMessage}`,
                error instanceof Error ? error.stack : undefined,
              );
              if (responseData != null) {
                this.logger.error(
                  `Open Router 400 response body: ${this.safeStringify(responseData)}`,
                );
              }
              this.logger.error(
                `Open Router request summary: ${this.safeStringify(requestLogSummary)}`,
              );
              throw new InternalServerErrorException(
                `Failed to call Open Router API: ${errorMessage}`,
              );
            }),
          ),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error calling Open Router: ${error}`);
      throw error;
    }
  }

  /**
   * 일반적인 LLM 호출 (Tool 없이)
   */
  async callLLM(
    messages: OpenRouterMessage[],
    model?: string,
    options?: {
      temperature?: number;
      max_tokens?: number;
    },
  ): Promise<OpenRouterResponse> {
    const request: OpenRouterRequest = {
      model: model || this.defaultModel,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 2000,
    };

    const requestLogSummary = {
      model: request.model,
      stream: false,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      messages: this.summarizeOpenRouterMessages(messages),
    };

    try {
      const response = await firstValueFrom(
        this.httpService
          .post<OpenRouterResponse>(
            `${this.baseUrl}/chat/completions`,
            request,
            {
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': this.configService.get<string>('DOMAIN_NAME'),
                'X-Title': this.configService.get<string>('OPEN_ROUTER_TITLE'),
              },
              timeout: 15000,
            },
          )
          .pipe(
            catchError((error: AxiosError) => {
              const errorMessage = error.message;
              const statusCode = error.response?.status;
              const responseData = error.response?.data;
              this.logger.error(
                `Open Router API error (status ${statusCode}): ${errorMessage}`,
                error instanceof Error ? error.stack : undefined,
              );
              if (responseData != null) {
                this.logger.error(
                  `Open Router error response body: ${this.safeStringify(responseData)}`,
                );
              }
              this.logger.error(
                `Open Router request summary: ${this.safeStringify(requestLogSummary)}`,
              );
              throw new InternalServerErrorException(
                `Failed to call Open Router API: ${errorMessage}`,
              );
            }),
          ),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error calling Open Router: ${error}`);
      throw error;
    }
  }
}
