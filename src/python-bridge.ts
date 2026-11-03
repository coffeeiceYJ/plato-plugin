import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { BusinessResult, ExecutionContext } from '@software-factory/runtime-sdk';
import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import type { PlatoConfig } from './config.js';
import type { PlatoInput } from './business.js';

const LIMIT = 4 * 1024 * 1024;
const PROTOCOL = 1;
// Stage milestones, not elapsed-time estimates. Retries remain at the current milestone.
const STAGE_PROGRESS: Readonly<Record<string, number>> = {
  activity_identification: 5,
  structure_decomposition: 20,
  information_integration: 65,
  plantuml_generation: 80,
  rendering: 95,
};

async function* lines(stream: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > LIMIT) throw new Error('PLATO_PROTOCOL_LIMIT: message exceeds 4 MiB');
      yield line;
    }
    if (Buffer.byteLength(buffer) > LIMIT) throw new Error('PLATO_PROTOCOL_LIMIT: unterminated message exceeds 4 MiB');
  }
  buffer += decoder.end();
  if (buffer) throw new Error('PLATO_PROTOCOL_INVALID: incomplete final message');
}
function send(stream: Writable, value: unknown): Promise<void> {
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > LIMIT) return Promise.reject(new Error('PLATO_PROTOCOL_LIMIT: input exceeds 4 MiB'));
  return new Promise((resolve, reject) => stream.write(line, 'utf8', error => error ? reject(error) : resolve()));
}

export async function callPlatoPython(
  subprocess: SubprocessRuntime, config: PlatoConfig,
  input: Readonly<PlatoInput>, execution: ExecutionContext,
): Promise<BusinessResult> {
  execution.signal.throwIfAborted();
  if (!isAbsolute(config.plantumlJarPath)) throw new Error('PLATO_CONFIG_REQUIRED: 请在插件管理的 PLATO 详情页填写 PlantUML JAR 的服务端绝对路径并保存。');
  const jar = await realpath(config.plantumlJarPath);
  if (!(await stat(jar)).isFile()) throw new Error('PLATO_CONFIG_INVALID: PlantUML JAR 不存在。');
  const python = await subprocess.resolveExecutable(config.pythonPath, undefined, execution.signal);
  const java = await subprocess.resolveExecutable(config.javaPath, undefined, execution.signal);
  const outputDirectory = await realpath(execution.outputDirectory);
  const worker = fileURLToPath(new URL('../python/worker.py', import.meta.url));
  const sourceRoot = await realpath(fileURLToPath(new URL('../python/plato', import.meta.url)));
  const ownController = new AbortController();
  const signal = AbortSignal.any([execution.signal, ownController.signal]);
  const child = subprocess.spawn({
    argv: [python, '-u', worker], cwd: outputDirectory,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
    graceMs: 2000, signal,
    env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
  });
  const outcome = child.done.then(value => ({ value }), error => ({ error }));
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    child.terminate();
    await outcome;
    if (!await child.waitForExit(AbortSignal.timeout(10000))) throw new Error('PLATO_CLEANUP_FAILED: Python 进程范围未在期限内退出。');
  })();
  execution.registerCleanup(cleanup);
  const timer = setTimeout(() => ownController.abort(new Error('PLATO_STARTUP_TIMEOUT: Python 未确认任务目录可写。')), config.startupTimeoutMs);
  timer.unref();
  let ready = false;
  let result: string | undefined;
  let modelSequence = 0;
  let lastProgress = 0;
  const files = new Map<string, string>();
  let stdinError: Error | undefined;
  child.stdin?.on('error', (error: Error) => { stdinError = error; ownController.abort(error); });
  try {
    if (!child.stdin || !child.stdout) throw new Error('PLATO_PROCESS_FAILED: Python 标准输入输出不可用。');
    await send(child.stdin, {
      protocol: PROTOCOL, runId: execution.runId, type: 'start',
      requirement_text: input.requirement_text, outputDirectory, sourceRoot,
      plantumlJarPath: jar, javaPath: java,
    });
    for await (const line of lines(child.stdout)) {
      signal.throwIfAborted();
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; }
      catch { throw new Error('PLATO_PROTOCOL_INVALID: stdout 必须是一行一条 JSON。'); }
      if (!message || message.protocol !== PROTOCOL || message.runId !== execution.runId) throw new Error('PLATO_PROTOCOL_INVALID: 协议或任务归属不匹配。');
      if (result !== undefined) throw new Error('PLATO_PROTOCOL_INVALID: result 后仍收到消息。');
      switch (message.type) {
        case 'ready':
          if (ready) throw new Error('PLATO_PROTOCOL_INVALID: duplicate ready');
          ready = true; clearTimeout(timer);
          await execution.log('Python 已接收需求，并在本次任务目录实际写入成功。', 'preparation');
          break;
        case 'progress': {
          if (!ready || typeof message.stage !== 'string' || typeof message.stageName !== 'string') throw new Error('PLATO_PROTOCOL_INVALID: invalid progress');
          const milestone = STAGE_PROGRESS[message.stage];
          if (typeof milestone !== 'number') throw new Error('PLATO_PROTOCOL_INVALID: unknown progress stage');
          lastProgress = Math.max(lastProgress, milestone);
          await execution.reportProgress({
            stage: message.stage, stageName: message.stageName, progress: lastProgress,
            message: '估算进度：按执行阶段计算，不代表剩余时间或生成质量。',
          });
          break;
        }
        case 'log':
          if (typeof message.message !== 'string' || typeof message.stage !== 'string') throw new Error('PLATO_PROTOCOL_INVALID: invalid log');
          await execution.log(message.message.slice(0, 4000), message.stage);
          break;
        case 'warning':
          if (typeof message.message !== 'string' || typeof message.code !== 'string') throw new Error('PLATO_PROTOCOL_INVALID: invalid warning');
          await execution.reportIssue({ level: 'warning', code: message.code, message: message.message.slice(0, 4000) });
          break;
        case 'model_request': {
          modelSequence += 1;
          if (!ready || message.id !== String(modelSequence) || !Array.isArray(message.messages) || message.messages.length !== 2) throw new Error('PLATO_PROTOCOL_INVALID: invalid model request');
          const messages = message.messages as Array<{ role: string; content: unknown }>;
          if (messages[0]?.role !== 'system' || messages[1]?.role !== 'user' || messages.some(m => typeof m.content !== 'string')) throw new Error('PLATO_PROTOCOL_INVALID: expected original system/user text messages');
          if (typeof message.temperature !== 'number' || !Number.isFinite(message.temperature) || message.temperature < 0 || message.temperature > 2) throw new Error('PLATO_PROTOCOL_INVALID: temperature must be a finite number from 0 to 2');
          try {
            const response = await execution.model.call({ messages: [
              { role: 'system', content: messages[0]!.content as string },
              { role: 'user', content: messages[1]!.content as string },
            ], temperature: message.temperature });
            signal.throwIfAborted();
            if (!response.text.trim()) throw new Error('PLATO_MODEL_EMPTY: 模型返回空文本。');
            await send(child.stdin, { protocol: PROTOCOL, runId: execution.runId, type: 'model_response', id: message.id, text: response.text, usage: response.usage });
          } catch (error) {
            throw new Error(`PLATO_MODEL_FAILED: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
          break;
        }
        case 'artifact': {
          const { relativePath, kind, name, mime } = message;
          if (typeof relativePath !== 'string' || typeof name !== 'string' || typeof mime !== 'string') throw new Error('PLATO_PROTOCOL_INVALID: invalid artifact');
          if (!/^(?:input|intermediate|snapshots|final)\/[a-zA-Z0-9_.-]+$/.test(relativePath) || relativePath.includes('..') || files.has(relativePath)) throw new Error('PLATO_PROTOCOL_INVALID: invalid or duplicate artifact path');
          const expectedKind = relativePath.startsWith('final/') ? 'final' : 'intermediate';
          if (kind !== expectedKind) throw new Error('PLATO_PROTOCOL_INVALID: artifact kind mismatch');
          const artifact = await execution.addArtifact({ kind: expectedKind, name, relativePath, mime });
          files.set(relativePath, artifact.artifactId);
          break;
        }
        case 'result':
          if (!ready || typeof message.text !== 'string' || !message.text.trim()) throw new Error('PLATO_PROTOCOL_INVALID: invalid result');
          result = message.text;
          break;
        case 'error': throw new Error(typeof message.message === 'string' ? message.message : 'PLATO_PYTHON_FAILED');
        default: throw new Error('PLATO_PROTOCOL_INVALID: unknown message type');
      }
    }
    const settled = await outcome;
    signal.throwIfAborted();
    if ('error' in settled) throw settled.error;
    if (settled.value.exitCode !== 0 || stdinError) throw stdinError ?? new Error(`PLATO_PYTHON_FAILED: exit ${settled.value.exitCode}`);
    const source = files.get('final/activity.puml'), image = files.get('final/activity.png');
    if (!result || !source || !image) throw new Error('PLATO_RESULT_MISSING: Python 未交付完整源码和 PNG。');
    await cleanup();
    signal.throwIfAborted();
    await execution.reportProgress({
      stage: 'delivery', stageName: '文件交付完成', progress: 100,
      message: 'PlantUML 源码和 PNG 图片已生成并登记；生成质量请核对需求。',
    });
    return { text: result, files: [source, image] };
  } catch (error) {
    const tail = child.collected.stderr?.readFrom(0).text.trim();
    if (tail) await execution.log(tail.slice(-4000), 'python_error').catch(() => {});
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    await cleanup();
  }
}
