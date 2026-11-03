import z from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cordis';
export interface PlatoConfig {
  pythonPath: string;
  javaPath: string;
  plantumlJarPath: string;
  startupTimeoutMs: number;
}
export type LivePlatoConfig = { [K in keyof PlatoConfig]: Volatile<PlatoConfig[K]> };

export const Config = z.object({
  pythonPath: z.string().pattern(/\S/).default('python').description('服务端 Python 解释器绝对路径，推荐独立虚拟环境。').volatile(),
  javaPath: z.string().pattern(/\S/).default('java').description('Java 绝对路径或 PATH 中的 java。').volatile(),
  // An empty initial path lets the configuration page load before setup.
  plantumlJarPath: z.string().default('').description('服务端 PlantUML JAR 的绝对路径；启动任务前必须填写。').volatile(),
  startupTimeoutMs: z.number().min(1000).max(120000).default(30000).description('等待 Python 确认任务目录可写的毫秒数。').volatile(),
});

/** Capture accepted values once, so live edits cannot change an existing Run. */
export function snapshotConfig(config: LivePlatoConfig): Readonly<PlatoConfig> {
  return Object.freeze({
    pythonPath: config.pythonPath.get(), javaPath: config.javaPath.get(),
    plantumlJarPath: config.plantumlJarPath.get(), startupTimeoutMs: config.startupTimeoutMs.get(),
  });
}
