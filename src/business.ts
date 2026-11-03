import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { BusinessResult, ExecutionContext } from '@software-factory/runtime-sdk';
import type { PlatoConfig } from './config.js';
import { callPlatoPython } from './python-bridge.js';

export interface PlatoInput { requirement_text: string }

/** SDK README 3.1: 接收参数、执行原算法、上报并交回结果。 */
export async function runPlato(
  input: Readonly<PlatoInput>, execution: ExecutionContext,
  subprocess: SubprocessRuntime, config: PlatoConfig,
): Promise<BusinessResult> {
  execution.signal.throwIfAborted();
  if (!input.requirement_text.trim()) throw new Error('PLATO_INPUT_EMPTY: 需求不能全为空白。');
  await execution.log('开始生成 PLATO 活动图');
  await execution.reportProgress({
    stage: 'preparation', stageName: '准备 PLATO 执行环境', progress: 0,
    message: '估算进度：按执行阶段计算，不代表剩余时间或生成质量。',
  });
  return callPlatoPython(subprocess, config, input, execution);
}
