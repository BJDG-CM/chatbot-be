import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ListResourcesResult,
  ListResourceItem,
} from '../../mcp/mcp-client.service';
import { McpClientService } from '../../mcp/mcp-client.service';
import { OpenRouterService } from './open-router.service';
import { ChatService } from './chat.service';
import { UsageService } from '../../usage/usage.service';
import type {
  McpTool,
  OpenRouterMessage,
  OpenRouterUsage,
} from '../types/open-router.types';
import { MessageRole } from '../../common/dto/chat-message-input.dto';
import type { Readable } from 'stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  DOCUMENT_SELECTION_SYSTEM_PROMPT,
  getDocumentSelectionUserPrompt,
  RESOURCE_PATH_SELECTION_SYSTEM_PROMPT,
  getResourcePathSelectionUserPrompt,
  CHUNK_SELECTION_SYSTEM_PROMPT,
  getChunkSelectionUserPrompt,
  formatResourceListForChunkSelection,
  FINAL_RESPONSE_SYSTEM_PROMPT,
  NO_RELEVANT_MATERIALS_SYSTEM_PROMPT,
} from '../prompts';

/**
 * 리소스 정보
 */
export interface ResourceInfo {
  path: string; // 문서 제목 (PDF/PNG인 경우 format 포함)
  formats: string[];
  url: string;
}

interface ProcessUserQuestionStreamOptions {
  persistUserMessage?: boolean;
  historyBefore?: Date;
}

interface StreamingResponseOptions extends ProcessUserQuestionStreamOptions {
  assistantMetadata?: Record<string, unknown>;
}

/**
 * 채팅 오케스트레이션 서비스
 * 사용자 질문을 받아 LLM과 MCP Tool을 조합하여 답변을 생성합니다.
 */
@Injectable()
export class ChatOrchestrationService {
  private readonly logger = new Logger(ChatOrchestrationService.name);

  // Tool 목록 캐시 (5분간 유효)
  private cachedTools: McpTool[] | null = null;
  private cachedToolsTimestamp: number = 0;
  private readonly TOOLS_CACHE_TTL = 5 * 60 * 1000; // 5분

  // Tool 실행 타임아웃 (30초)
  private readonly TOOL_EXECUTION_TIMEOUT = 30 * 1000;

  constructor(
    private readonly mcpClientService: McpClientService,
    private readonly openRouterService: OpenRouterService,
    private readonly chatService: ChatService,
    private readonly usageService: UsageService,
    private readonly configService: ConfigService,
  ) {}

  private createEmptyUsage(): OpenRouterUsage {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
  }

  private addTokenUsage(
    target: OpenRouterUsage | undefined,
    usage: OpenRouterUsage | null | undefined,
  ): void {
    if (!target || !usage) return;

    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;

    target.prompt_tokens += promptTokens;
    target.completion_tokens += completionTokens;
    target.total_tokens += totalTokens;
  }

  private hasTokenUsage(usage: OpenRouterUsage): boolean {
    return (
      usage.prompt_tokens > 0 ||
      usage.completion_tokens > 0 ||
      usage.total_tokens > 0
    );
  }

  /**
   * MCP Tool 목록을 가져오거나 캐시에서 반환
   */
  private async getMcpTools(): Promise<McpTool[]> {
    const now = Date.now();
    if (
      this.cachedTools &&
      now - this.cachedToolsTimestamp < this.TOOLS_CACHE_TTL
    ) {
      this.logger.debug('Using cached MCP tools');
      return this.cachedTools;
    }

    this.logger.debug('Fetching MCP tools from server...');
    const mcpToolsListResult: unknown = await this.mcpClientService.listTools();

    type ToolItem = {
      name: string;
      description?: string;
      inputSchema?: McpTool['inputSchema'];
    };
    const mcpToolsList: ToolItem[] = Array.isArray(mcpToolsListResult)
      ? (mcpToolsListResult as ToolItem[])
      : [];
    const mcpTools: McpTool[] = mcpToolsList.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    }));

    this.cachedTools = mcpTools;
    this.cachedToolsTimestamp = now;

    return mcpTools;
  }

  /**
   * 리소스 경로 정규화
   * MCP 서버는 확장자 없이 경로를 받고 자동으로 .md 또는 .pdf를 찾으므로,
   * 확장자를 제거하여 전달합니다.
   */
  private normalizeResourcePath(path: string): string {
    // 확장자가 있으면 제거 (MCP 서버가 자동으로 찾음)
    if (path.includes('.')) {
      const lastDotIndex = path.lastIndexOf('.');
      // 마지막 점 이후가 확장자인 경우 (예: .md, .pdf)
      const extension = path.substring(lastDotIndex + 1);
      if (extension.length <= 5 && /^[a-z0-9]+$/i.test(extension)) {
        return path.substring(0, lastDotIndex);
      }
    }
    return path;
  }

  /**
   * 경로에서 마지막 문서 제목만 추출 (확장자 포함)
   * 예: "2025 캠프 발표자료_ 1일차 오전/학생지원.md" -> "학생지원.md"
   * 원본 경로에 확장자가 없으면 formats 배열에서 찾아서 추가
   */
  private extractDocumentTitle(
    path: string,
    originalPath?: string,
    formats?: string[],
  ): string {
    // 원본 경로가 있으면 원본 경로 사용 (확장자 포함)
    const pathToUse = originalPath || path;

    // 슬래시로 분리하여 마지막 부분만 반환
    const parts = pathToUse.split('/');
    let title = parts[parts.length - 1] || pathToUse;

    // 확장자가 없고 formats 배열에 md가 있으면 .md 추가
    if (!title.includes('.') && formats && formats.includes('md')) {
      title = `${title}.md`;
    }

    return title;
  }

  /**
   * FE·리소스 API용 PDF 경로: 하위 chunk/이미지 경로가 아니라 상위 묶음 PDF 한 개
   * 예: `에어컨+…/세부/파일.png` → `에어컨+….pdf` (첫 `/` 앞 세그먼트 + `.pdf`)
   */
  private normalizeTopLevelPdfPathForFe(resourcePath: string): string {
    const first = resourcePath.split('/')[0]?.trim() || resourcePath;
    const base = first.replace(/\.(pdf|png|md|jpe?g|gif|webp)$/i, '');
    return `${base}.pdf`;
  }

  /**
   * SSE·메타데이터용 참조 문서: **PDF 번들만** (마크다운 chunk 경로는 상위 세그먼트 + `.pdf`로 변환).
   * 예: `2026년+학사편람/…/졸업요건.md` → `2026년+학사편람.pdf`
   */
  private appendFePdfResourceEntryFromUsed(
    out: ResourceInfo[],
    seenPdfPaths: Set<string>,
    r: { path: string; formats: string[] },
  ): void {
    if (!r.path || !r.formats?.length) return;
    const contributes =
      r.formats.includes('md') ||
      r.formats.includes('pdf') ||
      r.formats.includes('png');
    if (!contributes) return;

    const pathForFe = this.normalizeTopLevelPdfPathForFe(r.path);
    if (seenPdfPaths.has(pathForFe)) return;
    seenPdfPaths.add(pathForFe);

    out.push({
      path: pathForFe,
      formats: ['pdf'],
      url: this.generateResourceUrl(pathForFe),
    });
  }

  /**
   * get_resource 툴 응답에서 텍스트 내용 추출
   * MCP 서버는 문자열을 직접 반환하므로, texts 배열이나 raw.content에서 추출
   */
  private extractContentFromToolResult(
    toolResult: Awaited<ReturnType<typeof this.mcpClientService.callTool>>,
  ): string {
    // texts 배열에서 내용 추출 (가장 일반적인 경우)
    if (toolResult.texts.length > 0) {
      // texts가 여러 개인 경우 합치기
      const content = toolResult.texts.join('\n');
      // JSON 문자열이 아닌 경우 그대로 반환
      if (
        content &&
        !content.trim().startsWith('{') &&
        !content.trim().startsWith('[')
      ) {
        return content;
      }
    }

    // raw.content에서 text 타입 항목 추출
    const raw = toolResult.raw as {
      content?: Array<{ type: string; text?: string }>;
    };
    if (raw?.content) {
      const textContents: string[] = [];
      for (const item of raw.content) {
        if (item.type === 'text' && 'text' in item) {
          const text = item.text;
          // JSON 문자열이 아닌 경우 그대로 추가
          if (
            text &&
            !text.trim().startsWith('{') &&
            !text.trim().startsWith('[')
          ) {
            textContents.push(text);
          }
        }
      }
      if (textContents.length > 0) {
        return textContents.join('\n');
      }
    }

    return '';
  }

  /**
   * 신 형식: LLM에게 description을 보고 관련 chunk 경로 최대 maxResults개 선택 (JSON 배열 반환)
   */
  private async selectRelevantChunkPaths(
    question: string,
    resources: ListResourceItem[],
    maxResults: number = 10,
    tokenUsage?: OpenRouterUsage,
  ): Promise<string[]> {
    if (!resources?.length) {
      return [];
    }

    const resourceListText = formatResourceListForChunkSelection(resources);
    const userPrompt = getChunkSelectionUserPrompt({
      question,
      resourceListText,
      maxSelect: maxResults,
    });

    try {
      const response = await this.openRouterService.callLLM(
        [
          { role: 'system', content: CHUNK_SELECTION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        this.openRouterService.getModel('light'),
        { temperature: 0.1, max_tokens: 5000 },
      );
      this.addTokenUsage(tokenUsage, response.usage);

      let selectedText = response.choices[0]?.message?.content?.trim() || '';
      this.logger.debug(`LLM chunk selection raw: ${selectedText}`);

      // 마크다운 코드블록 제거 (```json ... ```)
      const codeBlockMatch = selectedText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        selectedText = codeBlockMatch[1].trim();
      }

      const parsed = JSON.parse(selectedText) as unknown;
      const paths = Array.isArray(parsed)
        ? (parsed as string[]).filter(
            (p) => typeof p === 'string' && p.length > 0,
          )
        : [];

      const limited = paths.slice(0, maxResults);
      this.logger.log(`[DEBUG] 1차 선별 결과(chunk 경로): ${limited.length}개`);
      return limited;
    } catch (error) {
      this.logger.warn(
        `Failed to select chunk paths by LLM: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * LLM으로 질문과 의미·맥락상 관련 있는 리소스 경로를 선별 (OpenRouter 사용, 구 형식)
   * 키워드 매칭 대신 의미 기반으로 최대 maxResults개 선택합니다.
   */
  private async selectRelevantResourcePaths(
    question: string,
    resources: Array<{ path: string; formats?: string[] }>,
    maxResults: number = 10,
    tokenUsage?: OpenRouterUsage,
  ): Promise<Array<{ path: string; formats?: string[] }>> {
    if (!resources.length) {
      return [];
    }

    const pathList = resources.map((r, i) => `${i + 1}. ${r.path}`).join('\n');

    const userPrompt = getResourcePathSelectionUserPrompt({
      pathList,
      question,
      maxSelect: maxResults,
    });

    try {
      const response = await this.openRouterService.callLLM(
        [
          { role: 'system', content: RESOURCE_PATH_SELECTION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        this.openRouterService.getModel('light'),
        { temperature: 0.1, max_tokens: 200 },
      );
      this.addTokenUsage(tokenUsage, response.usage);

      const selectedText = response.choices[0]?.message?.content?.trim() || '';
      this.logger.debug(`LLM selected resource paths: ${selectedText}`);

      if (selectedText.toLowerCase().includes('없음')) {
        return [];
      }

      const numbers =
        selectedText
          .match(/\d+/g)
          ?.map((n) => parseInt(n, 10) - 1)
          .filter((n) => n >= 0 && n < resources.length) || [];

      const uniqueIndices = [...new Set(numbers)].slice(0, maxResults);
      const selected = uniqueIndices.map((idx) => resources[idx]);

      this.logger.log(`Selected ${selected.length} resource path(s) by LLM`);
      return selected;
    } catch (error) {
      this.logger.warn(
        `Failed to select resource paths by LLM: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * 리소스 내용에서 <document> 태그를 파싱하여 하위 문서 정보 추출
   */
  private parseDocumentLinks(content: string): Array<{
    path: string;
    description: string;
  }> {
    const documents: Array<{ path: string; description: string }> = [];
    const documentRegex =
      /<document\s+path="([^"]+)"\s+description="([^"]+)"><\/document>/g;

    let match;
    while ((match = documentRegex.exec(content)) !== null) {
      documents.push({
        path: match[1],
        description: match[2],
      });
    }

    return documents;
  }

  /**
   * 마크다운에서 이미지 참조 추출: ![alt](path) 형태
   * 첨부된 이미지(.png, .jpg 등) 경로만 반환
   */
  private parseImageReferencesFromMarkdown(content: string): string[] {
    const paths: string[] = [];
    const imageRefRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = imageRefRegex.exec(content)) !== null) {
      const path = match[1].trim();
      if (/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(path)) {
        paths.push(path);
      }
    }
    return paths;
  }

  /**
   * 문서 경로 기준으로 상대 이미지 경로를 전체 리소스 경로로 변환
   * 예: docPath="폴더/문서.md", imageRef="이미지.png" → "폴더/이미지.png"
   */
  private resolveImagePath(imageRef: string, docPath: string): string {
    const lastSlash = docPath.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : docPath.slice(0, lastSlash + 1);
    return dir + imageRef;
  }

  /**
   * MD 링크/이미지의 상대 경로를 절대 리소스 경로로 변환 (`../` 처리)
   */
  private resolveRelativeResourcePath(ref: string, docPath: string): string {
    const raw = ref.trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
    if (!raw || /^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('/')) return raw.replace(/^\/+/, '');
    const lastSlash = docPath.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : docPath.slice(0, lastSlash + 1);
    const combined = dir + raw;
    const segments = combined.split('/').filter((s) => s.length > 0);
    const out: string[] = [];
    for (const s of segments) {
      if (s === '..') out.pop();
      else if (s !== '.') out.push(s);
    }
    return out.join('/');
  }

  /**
   * 선별된 MD 본문에서 PDF/PNG 참조 경로 추출 (마크다운 링크, 이미지, `<document>`)
   */
  private extractPdfPngReferencesFromMarkdown(
    content: string,
    docPath: string,
  ): Array<{ path: string; formats: string[] }> {
    const results: Array<{ path: string; formats: string[] }> = [];
    const seen = new Set<string>();
    const add = (p: string, fmt: 'pdf' | 'png') => {
      if (!p || seen.has(p)) return;
      seen.add(p);
      results.push({ path: p, formats: [fmt] });
    };

    const mdLink = /\[([^\]]*)\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = mdLink.exec(content)) !== null) {
      const inner = m[2].trim();
      const raw = inner.split(/\s+/)[0];
      if (/\.pdf$/i.test(raw)) {
        const full = this.resolveRelativeResourcePath(raw, docPath);
        if (!/^https?:\/\//i.test(full)) add(full, 'pdf');
      }
      if (/\.png$/i.test(raw)) {
        const full = this.resolveRelativeResourcePath(raw, docPath);
        if (!/^https?:\/\//i.test(full)) add(full, 'png');
      }
    }

    for (const img of this.parseImageReferencesFromMarkdown(content)) {
      const raw = img.trim().split(/[?#]/)[0];
      if (/\.png$/i.test(raw)) {
        const full = this.resolveRelativeResourcePath(raw, docPath);
        if (!/^https?:\/\//i.test(full)) add(full, 'png');
      }
    }

    for (const d of this.parseDocumentLinks(content)) {
      const p = d.path.trim();
      if (/\.pdf$/i.test(p)) {
        const full = p.includes('/')
          ? p
          : this.resolveRelativeResourcePath(p, docPath);
        if (!/^https?:\/\//i.test(full)) add(full, 'pdf');
      }
      if (/\.png$/i.test(p)) {
        const full = p.includes('/')
          ? p
          : this.resolveRelativeResourcePath(p, docPath);
        if (!/^https?:\/\//i.test(full)) add(full, 'png');
      }
    }

    return results;
  }

  /**
   * list_resources chunk 목록에서 선별된 상위 폴더와 같은 루트의 PDF/PNG chunk 경로 수집
   */
  private collectPdfPngPathsFromChunkCatalog(
    chunks: Array<{ path: string }> | undefined,
    selectedPaths: string[],
    max: number = 8,
  ): Array<{ path: string; formats: string[] }> {
    if (!chunks?.length || !selectedPaths.length) return [];
    const roots = new Set(
      selectedPaths.map((p) => p.split('/')[0]).filter(Boolean),
    );
    const out: Array<{ path: string; formats: string[] }> = [];
    const seen = new Set<string>();
    for (const c of chunks) {
      const isPdf = /\.pdf$/i.test(c.path);
      const isPng = /\.png$/i.test(c.path);
      if (!isPdf && !isPng) continue;
      const root = c.path.split('/')[0];
      if (!roots.has(root)) continue;
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push({ path: c.path, formats: isPdf ? ['pdf'] : ['png'] });
      if (out.length >= max) break;
    }
    return out;
  }

  /**
   * 질문과 관련된 하위 문서 찾기
   */
  private findRelevantSubDocuments(
    question: string,
    documents: Array<{ path: string; description: string }>,
    maxResults: number = 3,
  ): Array<{ path: string; description: string }> {
    const keywords =
      question
        .toLowerCase()
        .match(/[\uac00-\ud7a3]+|[a-z]+/gi)
        ?.filter((word) => word.length > 1) || [];

    if (keywords.length === 0) {
      return documents.slice(0, maxResults);
    }

    const scoredDocuments = documents.map((doc) => {
      const pathLower = doc.path.toLowerCase();
      const descLower = doc.description.toLowerCase();
      let score = 0;

      for (const keyword of keywords) {
        if (pathLower.includes(keyword)) {
          score += keyword.length * 2; // 경로 매칭은 가중치 높게
        }
        if (descLower.includes(keyword)) {
          score += keyword.length; // 설명 매칭
        }
      }

      return { document: doc, score };
    });

    return scoredDocuments
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((item) => item.document);
  }

  /**
   * 하위 문서 내용 가져오기
   */
  private async fetchSubDocumentContents(
    subDocuments: Array<{ path: string; description: string }>,
  ): Promise<string> {
    const results = await Promise.all(
      subDocuments.map(async (doc) => {
        try {
          const resourcePath = this.normalizeResourcePath(doc.path);
          this.logger.debug(`Fetching sub-document: ${resourcePath}`);
          const toolResult = await this.mcpClientService.callTool(
            'get_resource',
            { path: resourcePath },
          );
          const content = this.extractContentFromToolResult(toolResult);
          if (content) {
            const documentTitle = this.extractDocumentTitle(
              resourcePath,
              doc.path,
              ['md'],
            );
            return `\n\n## 하위 문서: ${documentTitle}\n\n**설명**: ${doc.description}\n\n${content}`;
          }
        } catch (error) {
          this.logger.warn(
            `Failed to fetch sub-document ${doc.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return '';
      }),
    );
    return results.filter(Boolean).join('\n');
  }

  /**
   * LLM에게 문서 목록을 주고 질문과 관련성이 높은 문서만 선별하도록 요청
   */
  private async selectMostRelevantDocuments(
    question: string,
    documents: Array<{ title: string; content: string; path: string }>,
    tokenUsage?: OpenRouterUsage,
  ): Promise<Array<{ title: string; content: string; path: string }>> {
    if (documents.length === 0) {
      return [];
    }

    // 문서가 1개면 선별 불필요
    if (documents.length === 1) {
      return documents;
    }

    try {
      // 제목 + 내용 앞부분(요약)을 주어 경로/제목에 키워드가 없어도 내용으로 관련 문서 선별 가능하게 함
      const CONTENT_SNIPPET_LENGTH = 280;
      const documentList = documents
        .map((doc, index) => {
          const snippet =
            doc.content.length > CONTENT_SNIPPET_LENGTH
              ? doc.content
                  .slice(0, CONTENT_SNIPPET_LENGTH)
                  .replace(/\n/g, ' ') + '...'
              : doc.content.replace(/\n/g, ' ');
          return `${index + 1}. ${doc.title}\n   내용 요약: ${snippet}`;
        })
        .join('\n\n');

      const selectionPrompt = getDocumentSelectionUserPrompt({
        documentList,
        question,
      });

      this.logger.debug(
        `Selection prompt length: ${selectionPrompt.length} chars, documents: ${documents.length}`,
      );

      const response = await this.openRouterService.callLLM(
        [
          {
            role: 'system',
            content: DOCUMENT_SELECTION_SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: selectionPrompt,
          },
        ],
        this.openRouterService.getModel('normal'),
        { temperature: 0.1, max_tokens: 100 },
      );
      this.addTokenUsage(tokenUsage, response.usage);

      const selectedText = response.choices[0]?.message?.content?.trim() || '';
      this.logger.debug(`LLM selected documents: ${selectedText}`);

      // "없음"이면 빈 배열 반환 (관련 없는 질문일 수 있으므로 문서 강제 선택 안 함)
      if (selectedText.toLowerCase().includes('없음')) {
        return [];
      }

      // 번호 추출 (예: "1, 3, 5" 또는 "1,3,5")
      const numbers =
        selectedText
          .match(/\d+/g)
          ?.map((n) => parseInt(n, 10) - 1) // 0-based index로 변환
          .filter((n) => n >= 0 && n < documents.length) || [];

      if (numbers.length === 0) {
        // 번호를 파싱할 수 없으면 앞쪽 문서 반환 (최대 5개)
        this.logger.warn(
          `Could not parse document selection, returning first 5 documents`,
        );
        return documents.slice(0, 5);
      }

      // 최대 5개로 제한 (중요 문서 놓치지 않도록)
      const limitedNumbers = numbers.slice(0, 5);
      const selected = limitedNumbers.map((idx) => documents[idx]);
      this.logger.log(
        `Selected ${selected.length} relevant document(s) out of ${documents.length}`,
      );

      return selected;
    } catch (error) {
      this.logger.warn(
        `Failed to select relevant documents: ${error instanceof Error ? error.message : String(error)}`,
      );
      // 에러 발생 시 모든 문서 반환
      return documents;
    }
  }

  /**
   * 신 형식 list_resources: description 기반 chunk 선별 → get_resource(chunk_path) → 본문 수집
   * @param catalogChunks 전체 chunk 목록(평탄화). PDF/PNG 전용 chunk를 FE 참조용으로 붙일 때 사용
   */
  private async fetchRelevantContentsFromChunks(
    question: string,
    resources: ListResourceItem[],
    catalogChunks?: Array<{ path: string }>,
    tokenUsage?: OpenRouterUsage,
  ): Promise<{
    content: string;
    usedResources: Array<{ path: string; formats: string[] }>;
  }> {
    this.logger.log(
      `[DEBUG] 1차 선별(description 기준) 입력: 상위 리소스 ${resources.length}개, chunk 총 ${resources.reduce((s, r) => s + (r.chunks?.length ?? 0), 0)}개 → LLM에 전달`,
    );

    let t0 = Date.now();
    const chunkPaths = await this.selectRelevantChunkPaths(
      question,
      resources,
      10,
      tokenUsage,
    );
    this.logger.log(
      `[PERF] selectRelevantChunkPaths(LLM): ${Date.now() - t0}ms`,
    );

    if (chunkPaths.length === 0) {
      return { content: '', usedResources: [] };
    }

    t0 = Date.now();
    const chunkResults = await Promise.all(
      chunkPaths.map(async (chunkPath) => {
        try {
          const pathForTool = this.normalizeResourcePath(chunkPath);
          this.logger.debug(`Fetching chunk: ${pathForTool}`);
          const toolResult = await this.mcpClientService.callTool(
            'get_resource',
            { path: pathForTool },
          );
          const content = this.extractContentFromToolResult(toolResult);
          if (content) {
            const title = chunkPath.split('/').pop() || chunkPath || '문서';
            return { title, content, path: chunkPath };
          }
        } catch (error) {
          this.logger.warn(
            `Failed to fetch chunk ${chunkPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return null;
      }),
    );
    const documentCandidates = chunkResults.filter(
      (r): r is { title: string; content: string; path: string } => r !== null,
    );
    this.logger.log(
      `[PERF] get_resource 루프(신 형식, ${chunkPaths.length}개): ${Date.now() - t0}ms`,
    );

    if (documentCandidates.length === 0) {
      return { content: '', usedResources: [] };
    }

    this.logger.log(
      `[DEBUG] 2차 선별(본문 기준) 입력: 후보 문서 ${documentCandidates.length}개 → LLM에 전달`,
    );

    t0 = Date.now();
    const selectedDocuments = await this.selectMostRelevantDocuments(
      question,
      documentCandidates.map((doc) => ({
        title: doc.title,
        content: doc.content,
        path: doc.path,
      })),
      tokenUsage,
    );
    this.logger.log(
      `[PERF] selectMostRelevantDocuments(LLM, 신 형식): ${Date.now() - t0}ms`,
    );

    this.logger.log(
      `[DEBUG] 2차 선별 결과(최종 사용 문서): ${selectedDocuments.length}개`,
    );

    if (selectedDocuments.length === 0) {
      this.logger.log('No documents selected by LLM as relevant');
      return { content: '', usedResources: [] };
    }

    const contents: string[] = [];
    const mdUsed: Array<{ path: string; formats: string[] }> = [];

    for (const selected of selectedDocuments) {
      const doc = documentCandidates.find((d) => d.path === selected.path);
      if (doc) {
        contents.push(`\n\n## 리소스: ${doc.title}\n\n${doc.content}`);
        mdUsed.push({ path: doc.path, formats: ['md'] });
      }
    }

    const selectedPaths = selectedDocuments.map((s) => s.path);
    const fromMarkdown: Array<{ path: string; formats: string[] }> = [];
    for (const selected of selectedDocuments) {
      const doc = documentCandidates.find((d) => d.path === selected.path);
      if (!doc?.content) continue;
      fromMarkdown.push(
        ...this.extractPdfPngReferencesFromMarkdown(doc.content, doc.path),
      );
    }
    const fromCatalog = this.collectPdfPngPathsFromChunkCatalog(
      catalogChunks,
      selectedPaths,
      8,
    );

    const seenPdfPng = new Set<string>();
    const pdfPngExtras: Array<{ path: string; formats: string[] }> = [];
    for (const e of [...fromMarkdown, ...fromCatalog]) {
      if (seenPdfPng.has(e.path)) continue;
      seenPdfPng.add(e.path);
      pdfPngExtras.push(e);
    }

    const finalUsedResources = [
      ...mdUsed.slice(0, 5),
      ...pdfPngExtras.slice(0, 8),
    ];

    return {
      content: contents.join('\n'),
      usedResources: finalUsedResources,
    };
  }

  /**
   * list_resources tool 응답에서 관련 리소스 내용 가져오기
   * - 신 형식(resources + chunks): description 보고 chunk 경로 선별 → get_resource(chunk_path)
   * - 구 형식(filteredResources): 경로만 선별 후 get_resource
   * @returns 문서 내용과 usedResources(선별 경로·formats; chunk는 md 포함). FE 참조 목록은 PDF/PNG만 노출.
   */
  private async fetchRelevantResourceContents(
    question: string,
    listResult: ListResourcesResult,
    tokenUsage?: OpenRouterUsage,
  ): Promise<{
    content: string;
    usedResources: Array<{ path: string; formats: string[] }>;
  }> {
    const isNewFormat =
      listResult.resources &&
      listResult.resources.length > 0 &&
      listResult.chunks &&
      listResult.chunks.length > 0;

    if (isNewFormat) {
      return this.fetchRelevantContentsFromChunks(
        question,
        listResult.resources!,
        listResult.chunks,
        tokenUsage,
      );
    }

    const filteredResources = listResult.filteredResources;
    if (!filteredResources || filteredResources.length === 0) {
      return { content: '', usedResources: [] };
    }

    const mdResources = filteredResources.filter(
      (resource) => resource.formats && resource.formats.includes('md'),
    );

    if (mdResources.length === 0) {
      this.logger.debug('No markdown resources found in filtered resources');
      return { content: '', usedResources: [] };
    }

    this.logger.log(
      `[DEBUG] 1차 선별(경로 기준) 입력: MD 문서 ${mdResources.length}개 → LLM에 전달`,
    );

    let t0 = Date.now();
    const relevantResources = await this.selectRelevantResourcePaths(
      question,
      mdResources,
      10,
      tokenUsage,
    );
    this.logger.log(
      `[PERF] selectRelevantResourcePaths(LLM, 구 형식): ${Date.now() - t0}ms`,
    );

    if (relevantResources.length === 0) {
      return { content: '', usedResources: [] };
    }

    this.logger.log(
      `[DEBUG] 1차 선별 결과(상위 관련 문서 경로): ${relevantResources.length}개`,
    );

    t0 = Date.now();
    const resourceResults = await Promise.all(
      relevantResources.map(async (resource) => {
        try {
          const resourcePath = this.normalizeResourcePath(resource.path);
          this.logger.debug(`Fetching markdown resource: ${resourcePath}`);
          const toolResult = await this.mcpClientService.callTool(
            'get_resource',
            { path: resourcePath },
          );
          const content = this.extractContentFromToolResult(toolResult);
          if (content) {
            const documentTitle = this.extractDocumentTitle(
              resourcePath,
              resource.path,
              resource.formats,
            );
            const subDocuments = this.parseDocumentLinks(content);
            return {
              title: documentTitle,
              content,
              path: resource.path,
              formats: resource.formats || [],
              subDocuments,
            };
          }
        } catch (error) {
          this.logger.warn(
            `Failed to fetch ${resource.path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return null;
      }),
    );
    const documentCandidates = resourceResults.filter(
      (
        r,
      ): r is {
        title: string;
        content: string;
        path: string;
        formats: string[];
        subDocuments: Array<{ path: string; description: string }>;
      } => r !== null,
    );
    this.logger.log(
      `[PERF] get_resource 루프(구 형식, ${relevantResources.length}개): ${Date.now() - t0}ms`,
    );

    if (documentCandidates.length === 0) {
      return { content: '', usedResources: [] };
    }

    this.logger.log(
      `[DEBUG] 2차 선별(본문 기준) 입력: 후보 문서 ${documentCandidates.length}개 → LLM에 전달`,
    );

    t0 = Date.now();
    const selectedDocuments = await this.selectMostRelevantDocuments(
      question,
      documentCandidates.map((doc) => ({
        title: doc.title,
        content: doc.content,
        path: doc.path,
      })),
      tokenUsage,
    );
    this.logger.log(
      `[PERF] selectMostRelevantDocuments(LLM, 구 형식): ${Date.now() - t0}ms`,
    );

    this.logger.log(
      `[DEBUG] 2차 선별 결과(최종 사용 문서): ${selectedDocuments.length}개`,
    );
    console.log('selectedDocuments', selectedDocuments);

    if (selectedDocuments.length === 0) {
      this.logger.log('No documents selected by LLM as relevant');
      return { content: '', usedResources: [] };
    }

    const contents: string[] = [];
    const allSubDocuments: Array<{ path: string; description: string }> = [];
    const usedResources: Array<{ path: string; formats: string[] }> = [];
    const addedPaths = new Set<string>();

    for (const selected of selectedDocuments) {
      const docCandidate = documentCandidates.find(
        (d) => d.title === selected.title,
      );
      if (docCandidate) {
        contents.push(
          `\n\n## 리소스: ${docCandidate.title}\n\n${docCandidate.content}`,
        );

        const hasPdf = docCandidate.formats.includes('pdf');
        const hasPng = docCandidate.formats.includes('png');
        if (hasPdf || hasPng) {
          const pdfPngFormats = docCandidate.formats.filter(
            (f) => f === 'pdf' || f === 'png',
          );
          usedResources.push({
            path: docCandidate.path,
            formats: pdfPngFormats,
          });
          addedPaths.add(docCandidate.path);
        }

        if (docCandidate.subDocuments.length > 0) {
          allSubDocuments.push(...docCandidate.subDocuments);
        }
      }
    }

    for (const selected of selectedDocuments) {
      const path = selected.path;
      const firstSegment = path.split('/')[0];
      for (const r of filteredResources) {
        if (!r.formats) continue;
        if (addedPaths.has(r.path)) continue;
        if (r.formats.includes('pdf')) {
          const pathLower = r.path.toLowerCase();
          if (pathLower.endsWith('.png')) continue;
          const match =
            r.path === firstSegment ||
            r.path === `${firstSegment}.pdf` ||
            r.path.startsWith(`${firstSegment}.`);
          if (match) {
            usedResources.push({ path: r.path, formats: ['pdf'] });
            addedPaths.add(r.path);
          }
        }
      }
    }

    for (const selected of selectedDocuments) {
      const docCandidate = documentCandidates.find(
        (d) => d.title === selected.title,
      );
      if (!docCandidate?.content) continue;
      const imageRefs = this.parseImageReferencesFromMarkdown(
        docCandidate.content,
      );
      for (const imageRef of imageRefs) {
        const fullPath = this.resolveImagePath(imageRef, docCandidate.path);
        const pathWithoutExt = fullPath.replace(/\.(png|jpe?g|gif|webp)$/i, '');
        const r = filteredResources.find(
          (x) =>
            x.formats?.includes('png') &&
            !addedPaths.has(x.path) &&
            (x.path === fullPath ||
              x.path === pathWithoutExt ||
              x.path.toLowerCase() === fullPath.toLowerCase() ||
              x.path.toLowerCase() === pathWithoutExt.toLowerCase()),
        );
        if (r) {
          usedResources.push({ path: r.path, formats: ['png'] });
          addedPaths.add(r.path);
        }
      }
    }

    const finalUsedResources = usedResources.slice(0, 5);

    // 하위 문서 중 질문과 관련된 문서 찾아서 추가로 가져오기
    if (allSubDocuments.length > 0) {
      const relevantSubDocuments = this.findRelevantSubDocuments(
        question,
        allSubDocuments,
        3, // 최대 3개의 하위 문서만 추가로 가져오기
      );

      if (relevantSubDocuments.length > 0) {
        this.logger.log(
          `Fetching ${relevantSubDocuments.length} relevant sub-document(s)`,
        );
        t0 = Date.now();
        const subDocumentContents =
          await this.fetchSubDocumentContents(relevantSubDocuments);
        this.logger.log(
          `[PERF] fetchSubDocumentContents(${relevantSubDocuments.length}개): ${Date.now() - t0}ms`,
        );
        if (subDocumentContents) {
          contents.push('\n\n---\n\n## 관련 하위 문서\n' + subDocumentContents);
        }
      }
    }

    return {
      content: contents.join('\n'),
      usedResources: finalUsedResources,
    };
  }

  /**
   * Tool 실행에 타임아웃 적용
   */
  private async executeToolWithTimeout(
    toolCall: {
      id: string;
      name: string;
      arguments: Record<string, any>;
    },
    sessionId: string,
    userQuestion?: string,
  ): Promise<{
    tool_call_id: string;
    name: string;
    content: string;
    resources: ResourceInfo[];
    /** list_resources에서 실제 문서 내용을 붙였을 때만 true */
    hadReferenceContent: boolean;
  }> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool execution timeout: ${toolCall.name}`));
      }, this.TOOL_EXECUTION_TIMEOUT);
    });

    const executePromise = (async () => {
      this.logger.debug(
        `Calling tool: ${toolCall.name} with args: ${JSON.stringify(toolCall.arguments)}`,
      );

      const toolResult = await this.mcpClientService.callTool(
        toolCall.name,
        toolCall.arguments,
      );

      let resultText =
        toolResult.texts.join('\n') || JSON.stringify(toolResult.raw, null, 2);

      // list_resources tool인 경우, 관련 리소스 내용을 가져와서 추가
      let usedResourcesFromContent: Array<{
        path: string;
        formats: string[];
      }> = [];
      let hadReferenceContent = false;
      const listResult =
        toolCall.name === 'list_resources'
          ? (toolResult as ListResourcesResult)
          : null;
      const listHasResources =
        listResult &&
        ((listResult.chunks && listResult.chunks.length > 0) ||
          (listResult.filteredResources &&
            listResult.filteredResources.length > 0));
      if (
        toolCall.name === 'list_resources' &&
        userQuestion &&
        listHasResources &&
        listResult
      ) {
        const relevantResult = await this.fetchRelevantResourceContents(
          userQuestion,
          listResult,
        );
        const hasActualContent =
          typeof relevantResult.content === 'string' &&
          relevantResult.content.trim().length > 0;
        if (hasActualContent) {
          resultText += '\n\n' + relevantResult.content;
          usedResourcesFromContent = relevantResult.usedResources;
          hadReferenceContent = true;
        }
      }

      // 실제 사용된 리소스만 포함 (FE·SSE: 묶음 PDF만)
      const resources: ResourceInfo[] = [];
      const seenFePdfPaths = new Set<string>();
      if (usedResourcesFromContent.length > 0) {
        for (const resource of usedResourcesFromContent) {
          this.appendFePdfResourceEntryFromUsed(
            resources,
            seenFePdfPaths,
            resource,
          );
        }
      }

      return {
        tool_call_id: toolCall.id,
        name: toolCall.name,
        content: resultText,
        resources,
        hadReferenceContent,
      };
    })();

    return Promise.race([executePromise, timeoutPromise]);
  }

  /**
   * 사용자 질문을 처리하여 스트리밍 답변을 생성
   * @param sessionId 세션 ID
   * @param userQuestion 사용자 질문
   * @returns 스트리밍 응답 스트림과 리소스 정보
   */
  async processUserQuestionStream(
    sessionId: string,
    userQuestion: string,
    options: ProcessUserQuestionStreamOptions = {},
  ): Promise<{
    stream: Readable;
    resources: ResourceInfo[];
    usage: OpenRouterUsage;
  }> {
    const perfTurnStart = Date.now();
    const usage = this.createEmptyUsage();

    try {
      // 0. 과거 대화 조회 (현재 user 저장 전 → 직전 대화까지 context)
      let t0 = Date.now();
      const pastMessagesRaw = await this.chatService.getMessagesForContext(
        sessionId,
        options.historyBefore,
      );
      const historyMessages: OpenRouterMessage[] = [...pastMessagesRaw]
        .reverse()
        .map((msg) => ({ role: msg.role, content: msg.content }));
      this.logger.log(`[PERF] getMessagesForContext: ${Date.now() - t0}ms`);

      // 1. 사용자 메시지 저장
      if (options.persistUserMessage ?? true) {
        t0 = Date.now();
        await this.chatService.createMessage(sessionId, {
          role: MessageRole.USER,
          content: userQuestion,
        });
        this.logger.log(`[PERF] createMessage(user): ${Date.now() - t0}ms`);
      }

      // 2. list_resources 직접 호출 (도구 선택 LLM 없이)
      t0 = Date.now();
      this.logger.debug('Calling list_resources...');
      const listResult = (await this.mcpClientService.callTool(
        'list_resources',
        {},
      )) as ListResourcesResult;
      this.logger.log(`[PERF] list_resources: ${Date.now() - t0}ms`);

      // [DEBUG] list_resources 결과: 신 형식(resources+chunks) 또는 구 형식(filteredResources)
      const isNewFormat =
        listResult.resources &&
        listResult.resources.length > 0 &&
        listResult.chunks &&
        listResult.chunks.length > 0;
      const totalFromList = isNewFormat
        ? (listResult.total ?? listResult.resources?.length ?? 0)
        : (listResult.filteredResources?.length ?? 0);
      const chunkCount = listResult.chunks?.length ?? 0;
      this.logger.log(
        `[DEBUG] list_resources 결과: ${isNewFormat ? `신 형식 상위 ${listResult.resources?.length ?? 0}개, chunk ${chunkCount}개` : `구 형식 ${totalFromList}개 리소스`}`,
      );

      const hasResources =
        (listResult.chunks && listResult.chunks.length > 0) ||
        (listResult.filteredResources &&
          listResult.filteredResources.length > 0);
      if (!hasResources) {
        this.logger.warn('No resources from list_resources');
        const stream = await this.openRouterService.generateFinalResponseStream(
          [
            { role: 'system', content: NO_RELEVANT_MATERIALS_SYSTEM_PROMPT },
            ...historyMessages,
            { role: 'user', content: userQuestion },
          ],
          [],
          this.openRouterService.getModel('normal'),
          { temperature: 0 },
        );
        return { stream, resources: [], usage };
      }

      // 3. 관련 리소스 내용 가져오기 (신 형식: description 기반 chunk 선별 / 구 형식: 경로 선별 후 본문 fetch)
      t0 = Date.now();
      const relevantResult = await this.fetchRelevantResourceContents(
        userQuestion,
        listResult,
        usage,
      );
      this.logger.log(
        `[PERF] fetchRelevantResourceContents: ${Date.now() - t0}ms`,
      );

      const hasContent =
        typeof relevantResult.content === 'string' &&
        relevantResult.content.trim().length > 0;

      if (!hasContent) {
        this.logger.warn('No reference documents available.');
        const stream = await this.openRouterService.generateFinalResponseStream(
          [
            { role: 'system', content: NO_RELEVANT_MATERIALS_SYSTEM_PROMPT },
            ...historyMessages,
            { role: 'user', content: userQuestion },
          ],
          [],
          this.openRouterService.getModel('normal'),
          { temperature: 0 },
        );
        return { stream, resources: [], usage };
      }

      const resultText =
        listResult.texts.join('\n') || JSON.stringify(listResult.raw, null, 2);

      // OpenRouter 입력 길이가 커지면 400이 발생할 수 있어, tool 호출 컨텐츠는 하드 캡을 둡니다.
      // list_resources 원문은 매우 길 수 있어 목록만 줄이고, 선별 본문(relevantResult)은 잘리지 않게 합니다.
      // 선별 본문을 앞에 두어(목록보다 앞) 모델이 문서를 우선 활용하도록 합니다.
      const MAX_TOOL_CONTENT_CHARS = 50000;
      const separator = '\n\n';
      const relevantPart = relevantResult.content;
      const listPart = resultText;
      const fullContentOriginalChars =
        relevantPart.length + separator.length + listPart.length;

      const maxListChars = Math.max(
        0,
        MAX_TOOL_CONTENT_CHARS - relevantPart.length - separator.length,
      );
      const LIST_TRUNCATION_NOTE =
        '\n\n[Truncated: list_resources preview too long]';
      let listPartForTool = listPart;
      let fullContentWasTruncated = false;
      if (listPart.length > maxListChars) {
        const maxSlice = Math.max(
          0,
          maxListChars - LIST_TRUNCATION_NOTE.length,
        );
        listPartForTool = listPart.slice(0, maxSlice) + LIST_TRUNCATION_NOTE;
        fullContentWasTruncated = true;
      }
      let fullContent = relevantPart + separator + listPartForTool;
      if (fullContent.length > MAX_TOOL_CONTENT_CHARS) {
        const maxRel = Math.max(
          0,
          MAX_TOOL_CONTENT_CHARS - listPartForTool.length - separator.length,
        );
        fullContent =
          relevantPart.slice(0, maxRel) +
          '\n\n[Truncated: reference material too long]' +
          separator +
          listPartForTool;
        fullContentWasTruncated = true;
      }

      const syntheticToolCallId = 'list_resources_0';
      const toolResults: Array<{
        tool_call_id: string;
        name: string;
        content: string;
      }> = [
        {
          tool_call_id: syntheticToolCallId,
          name: 'list_resources',
          content: fullContent,
        },
      ];

      const allResources: ResourceInfo[] = [];
      console.log('relevantResult.usedResources', relevantResult.usedResources);
      const seenFePdfPaths = new Set<string>();
      for (const r of relevantResult.usedResources) {
        this.appendFePdfResourceEntryFromUsed(allResources, seenFePdfPaths, r);
      }

      // 4. 최종 응답 스트리밍 (synthetic assistant tool_call + tool 메시지)
      t0 = Date.now();
      this.logger.debug('Generating final response with tool results...');
      const messages: OpenRouterMessage[] = [
        { role: 'system', content: FINAL_RESPONSE_SYSTEM_PROMPT },
        ...historyMessages,
        { role: 'user', content: userQuestion },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: syntheticToolCallId,
              type: 'function',
              function: { name: 'list_resources', arguments: '{}' },
            },
          ],
        },
      ];

      const toolResultsContentCharsSum = toolResults.reduce(
        (sum, r) => sum + (r.content?.length ?? 0),
        0,
      );

      const roleCounts: Record<string, number> = {};
      let assistantToolCalls = 0;
      let contentNullCount = 0;
      for (const m of messages) {
        roleCounts[m.role] = (roleCounts[m.role] ?? 0) + 1;
        if (m.role === 'assistant') {
          assistantToolCalls += m.tool_calls?.length ?? 0;
        }
        if (m.content === null) {
          contentNullCount += 1;
        }
      }

      this.logger.debug(
        `[DEBUG] Final OpenRouter request summary: model=heavy, messages=${messages.length}, roles=${JSON.stringify(roleCounts)}, contentNullCount=${contentNullCount}, assistantToolCalls=${assistantToolCalls}, toolResults=${toolResults.length}, toolResultsContentCharsSum=${toolResultsContentCharsSum}, fullContentOriginalChars=${fullContentOriginalChars}, fullContentWasTruncated=${fullContentWasTruncated}, numberOfAllResources=${allResources.length}`,
      );

      const stream = await this.openRouterService.generateFinalResponseStream(
        messages,
        toolResults,
        this.openRouterService.getModel('heavy'),
      );
      this.logger.log(
        `[PERF] generateFinalResponseStream(시작까지): ${Date.now() - t0}ms`,
      );
      this.logger.log(
        `[PERF] processUserQuestionStream 전체: ${Date.now() - perfTurnStart}ms`,
      );

      return { stream, resources: allResources, usage };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Error processing user question: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        `Failed to process user question: ${errorMessage}`,
      );
    }
  }

  /**
   * 스트리밍 응답을 처리하여 SSE 형식으로 전송
   * @param sessionId 세션 ID
   * @param userQuestion 사용자 질문
   * @param reply Fastify 응답 객체
   * @param req Fastify 요청 객체 (CORS origin용)
   */
  async handleStreamingResponse(
    sessionId: string,
    userQuestion: string,
    reply: FastifyReply,
    req: FastifyRequest,
    options: StreamingResponseOptions = {},
  ): Promise<void> {
    reply.hijack();

    // credentials: true 사용 시 Access-Control-Allow-Origin은 * 불가, 요청 origin을 그대로 반환해야 함
    const allowedOrigins = [
      'http://localhost:5173',
      `https://${this.configService.get<string>('DOMAIN_NAME') ?? ''}`,
    ];
    const requestOrigin = req.headers.origin;
    const corsOrigin =
      requestOrigin && allowedOrigins.includes(requestOrigin)
        ? requestOrigin
        : (allowedOrigins[1] ?? '*');

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });

    try {
      const { stream, resources } = await this.mcpClientService.withSession(
        () =>
          this.processUserQuestionStream(sessionId, userQuestion, {
            persistUserMessage: options.persistUserMessage,
            historyBefore: options.historyBefore,
          }),
      );

      let accumulatedContent = '';
      let model = '';
      let finalResponseUsage: OpenRouterUsage | null = null;
      let buffer = '';

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') {
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              if (parsed.choices?.[0]?.delta?.content) {
                const content = parsed.choices[0].delta.content;
                accumulatedContent += content;
                reply.raw.write(`data: ${JSON.stringify({ content })}\n\n`);
              }
              if (parsed.model) {
                model = parsed.model;
              }
              if (parsed.usage) {
                finalResponseUsage = parsed.usage;
              }
            } catch {
              // JSON 파싱 실패 시 무시
            }
          }
        }
      });

      stream.on('error', (error) => {
        this.logger.error('Stream error:', error);
        reply.raw.write(
          `data: ${JSON.stringify({ error: error.message || 'Stream error' })}\n\n`,
        );
        reply.raw.end();
      });

      stream.on('end', () => {
        void (async () => {
          try {
            const totalUsage = { ...reasoningUsage };
            this.addTokenUsage(totalUsage, finalResponseUsage);
            const usage = this.hasTokenUsage(totalUsage)
              ? totalUsage
              : undefined;

            if (accumulatedContent) {
              await this.chatService.createMessage(sessionId, {
                role: MessageRole.ASSISTANT,
                content: accumulatedContent,
                metadata: {
                  ...(options.assistantMetadata ?? {}),
                  model: model || undefined,
                  usage,
                  resources: resources.length > 0 ? resources : undefined,
                },
              });
            }

            if (usage?.total_tokens != null) {
              try {
                await this.usageService.recordUsage(sessionId, {
                  totalTokens: usage.total_tokens,
                });
              } catch (err) {
                this.logger.warn(
                  'Failed to record usage',
                  err instanceof Error ? err.message : String(err),
                );
              }
            }

            if (resources.length > 0) {
              reply.raw.write(
                `data: ${JSON.stringify({
                  type: 'resources',
                  resources: resources,
                })}\n\n`,
              );
            }

            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
          } catch (error) {
            this.logger.error('Error saving final message:', error);
            reply.raw.write(
              `data: ${JSON.stringify({ error: 'Failed to save message' })}\n\n`,
            );
            reply.raw.end();
          }
        })();
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error('Error in chat stream:', errorMessage);
      reply.raw.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
      reply.raw.end();
    }
  }

  /**
   * 리소스 경로를 기반으로 URL 생성
   */
  private generateResourceUrl(resourcePath: string): string {
    const encodedPath = encodeURIComponent(resourcePath);
    return encodedPath;
  }
}
