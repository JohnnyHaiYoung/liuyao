import { ERROR_CODES } from '@/shared/types';
import { EMPTY_USAGE, type LlmProvider, type LlmStreamHandlers, type LlmStreamOptions, type LlmStreamResult } from './types';

/**
 * 本地验收用「假模型」（test double）。
 *
 * 目的：在没有真实 DeepSeek API Key 的环境里，验证服务器自身的流式通道、
 * 中断状态、用量保存与历史持久化是否工作。
 *
 * 约束（防止被误认为真实调用）：
 *   - 只有显式设置 LIUYAO_FAKE_MODEL=1 才注册；
 *   - 模型名固定为 `fake-stream-v1`，绝不会冒充 `deepseek-flash`；
 *   - 输出文本第一行就声明“验收用假模型”，页面顶部同时显示醒目提示；
 *   - 不联网、不产生任何费用，也不代表 DeepSeek 联调已通过。
 */

const MODEL_ID = 'fake-stream-v1';

const SCRIPT = [
  '（验收用假模型输出，未调用 DeepSeek 或任何模型服务）',
  '',
  '这段文字由服务器本地按固定节奏分段生成，用于验证：',
  '',
  '1. 服务端 → 浏览器的 SSE 增量是否逐段到达；',
  '2. 点击“停止”后是否保存为 interrupted；',
  '3. 完成、失败、中断状态是否写入 SQLite 并在刷新后仍可读取。',
  '',
  '它不包含任何六爻判断，也不代表模型能力。',
  '',
  '最终结果：本地验收假模型的固定文本，仅用于验证流式与持久化链路。',
];

/** 每段的间隔，保证有足够时间测试“停止生成”。 */
const CHUNK_DELAY_MS = 120;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeStreamProvider implements LlmProvider {
  readonly id = 'fake';
  readonly label = '验收用假模型（未调用任何模型服务）';
  readonly defaultModel = MODEL_ID;

  isConfigured(): boolean {
    return true;
  }

  listModels(): string[] {
    return [MODEL_ID];
  }

  async streamChat(options: LlmStreamOptions, handlers: LlmStreamHandlers): Promise<LlmStreamResult> {
    const chunks = Array.from(SCRIPT.join('\n'));
    for (let index = 0; index < chunks.length; index += 1) {
      await sleep(CHUNK_DELAY_MS, options.signal);
      if (options.signal.aborted) {
        return {
          status: 'interrupted',
          usedModel: MODEL_ID,
          usage: { ...EMPTY_USAGE },
          errorCode: ERROR_CODES.clientAborted,
          errorDetail: '假模型：客户端中止',
        };
      }
      handlers.onDelta(chunks[index]!);
    }
    const usage = { inputTokens: 0, outputTokens: chunks.length, totalTokens: chunks.length };
    handlers.onUsage?.(usage);
    return { status: 'completed', usedModel: MODEL_ID, usage, finishReason: 'stop' };
  }
}
