// main.ts
// A Deno-powered, single-file implementation of the aianswergenerator-2api project.

// --- 1. DEPENDENCY IMPORTS ---
// Deno Standard Library for environment variable loading and colored logging
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import { green, yellow, cyan, red } from "https://deno.land/std@0.224.0/fmt/colors.ts";

// --- 2. CONFIGURATION ---
// Load environment variables from .env file
const env = await load({ export: true });

const config = {
  APP_NAME: "aianswergenerator-2api (Deno Version)",
  APP_VERSION: "1.0.0",
  DESCRIPTION: "一个将 aianswergenerator.pro 的后端 API (pollinations.ai) 转换为兼容 OpenAI 格式的代理。",
  API_MASTER_KEY: Deno.env.get("API_MASTER_KEY") || "1",
  API_REQUEST_TIMEOUT: 120 * 1000, // in milliseconds
  NGINX_PORT: parseInt(Deno.env.get("NGINX_PORT") || "8090", 10),
  PSEUDO_STREAM_DELAY: 0.01 * 1000, // in milliseconds
  DEFAULT_MODEL: "aianswergenerator-openai",
  KNOWN_MODELS: ["aianswergenerator-openai"],
  UPSTREAM_MODEL_PARAM: "openai",
};

// --- 3. LOGGER UTILITY ---
const logger = {
  _format(level: string, color: (str: string) => string, msg: string) {
    const time = new Date().toISOString().replace("T", " ").replace("Z", "");
    console.log(
      `${green(time)} | ${color(level.padEnd(8))} | ${cyan("main.ts")} - ${msg}`,
    );
  },
  info(msg: string) {
    this._format("INFO", green, msg);
  },
  error(msg: string) {
    this._format("ERROR", red, msg);
  },
  success(msg: string) {
    this._format("SUCCESS", green, msg);
  },
};

// --- 4. SSE (SERVER-SENT EVENTS) UTILITIES ---
namespace SSE {
  const textEncoder = new TextEncoder();
  export const DONE_CHUNK = textEncoder.encode("data: [DONE]\n\n");

  export function createSseData(data: Record<string, unknown>): Uint8Array {
    const jsonString = JSON.stringify(data);
    return textEncoder.encode(`data: ${jsonString}\n\n`);
  }

  export function createChatCompletionChunk(
    requestId: string,
    model: string,
    content: string,
    finishReason: string | null = null,
  ): Record<string, unknown> {
    return {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          delta: { content: content },
          finish_reason: finishReason,
        },
      ],
    };
  }
}

// --- 5. CORE LOGIC PROVIDER ---
class AIAnswerGeneratorProvider {
  private readonly BASE_URL = "https://text.pollinations.ai";

  private _prepareHeaders(): Headers {
    return new Headers({
      "Accept": "*/*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Origin": "https://aianswergenerator.pro",
      "Referer": "https://aianswergenerator.pro/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
  }

  async getModels(): Promise<Response> {
    const modelData = {
      object: "list",
      data: config.KNOWN_MODELS.map((name) => ({
        id: name,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "lzA6",
      })),
    };
    return Response.json(modelData);
  }

  async chatCompletion(requestData: any): Promise<Response> {
    const stream = new ReadableStream({
      async start(controller) {
        const requestId = `chatcmpl-${crypto.randomUUID()}`;
        const modelName = requestData.model || config.DEFAULT_MODEL;

        try {
          const messages = requestData.messages || [];
          const lastUserMessage = messages.slice().reverse().find(
            (m: any) => m.role === "user",
          )?.content;

          if (!lastUserMessage) {
            throw new Error("未找到用户消息。");
          }

          const encodedPrompt = encodeURIComponent(lastUserMessage);
          const upstreamUrl = `${this.BASE_URL}/${encodedPrompt}?model=${config.UPSTREAM_MODEL_PARAM}`;
          const headers = this._prepareHeaders();

          logger.info(`请求上游 URL: GET ${upstreamUrl}`);
          
          const response = await fetch(upstreamUrl, {
            method: "GET",
            headers: headers,
            signal: AbortSignal.timeout(config.API_REQUEST_TIMEOUT),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`上游服务错误: ${response.status} - ${errorText}`);
          }

          const fullText = await response.text();
          logger.info(`收到上游完整响应，长度: ${fullText.length} characters.`);
          logger.info("开始执行伪流式生成...");

          for (const char of fullText) {
            const chunk = SSE.createChatCompletionChunk(requestId, modelName, char);
            controller.enqueue(SSE.createSseData(chunk));
            await new Promise(resolve => setTimeout(resolve, config.PSEUDO_STREAM_DELAY));
          }

          const finalChunk = SSE.createChatCompletionChunk(requestId, modelName, "", "stop");
          controller.enqueue(SSE.createSseData(finalChunk));
          controller.enqueue(SSE.DONE_CHUNK);
          logger.success("伪流式生成完成。");

        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : "内部服务器错误";
          logger.error(`处理流时发生未知错误: ${errorMessage}`);
          const errorChunk = SSE.createChatCompletionChunk(requestId, modelName, errorMessage, "stop");
          controller.enqueue(SSE.createSseData(errorChunk));
          controller.enqueue(SSE.DONE_CHUNK);
        } finally {
          controller.close();
        }
      },
      _prepareHeaders: this._prepareHeaders, // Pass context to the stream
      BASE_URL: this.BASE_URL,
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }
}

// --- 6. SERVER & ROUTING ---
async function mainHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const provider = new AIAnswerGeneratorProvider();

  // --- Security Middleware ---
  if (config.API_MASTER_KEY && config.API_MASTER_KEY !== "1") {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return Response.json({ detail: "需要 Bearer Token 认证。" }, { status: 401 });
    }
    const token = authHeader.substring(7);
    if (token !== config.API_MASTER_KEY) {
      return Response.json({ detail: "无效的 API Key。" }, { status: 403 });
    }
  }

  // --- Router ---
  if (req.method === "GET" && url.pathname === "/") {
    return Response.json({
      message: `欢迎来到 ${config.APP_NAME} v${config.APP_VERSION}. 服务运行正常。`,
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return provider.getModels();
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    try {
      const requestData = await req.json();
      return provider.chatCompletion(requestData);
    } catch (e) {
      logger.error(`处理聊天请求时发生顶层错误: ${e.message}`);
      return Response.json({ detail: `内部服务器错误: ${e.message}` }, { status: 500 });
    }
  }

  return Response.json({ detail: "Not Found" }, { status: 404 });
}

// --- 7. MAIN EXECUTION ---
logger.info(`应用启动中... ${config.APP_NAME} v${config.APP_VERSION}`);
logger.info("服务已进入 'Pseudo-Stream' 模式。");
logger.info(`服务将在 http://localhost:${config.NGINX_PORT} 上可用`);

Deno.serve({ port: config.NGINX_PORT }, mainHandler);
