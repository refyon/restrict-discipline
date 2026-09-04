// test/stubs/dsh-settings.mjs — @deepseek-ai/dsh-settings 最小桩（CI 零依赖用）。
// lib/index.js 仅顶层 import { settingsNamespace } 用于注册命名空间；
// apply() 内实际读写走 ctx.get('settings')（测试 mock），本桩只需返回可作注册键的对象。
export const settingsNamespace = (name) => ({ name })
