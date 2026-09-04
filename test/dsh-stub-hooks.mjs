// test/dsh-stub-hooks.mjs — 模块解析钩子（Node register）：把 host 运行时注入的
// @deepseek-ai peer 包映射到 test/stubs/ 本地最小桩，使 lib/index.js 可在
// 无 node_modules 环境（如 CI 零依赖 clone）加载。见 integration-host.mjs 顶部。
const STUBS = new Map([
  ['@deepseek-ai/dsh-settings', './stubs/dsh-settings.mjs'],
  ['@deepseek-ai/schemastery', './stubs/schemastery.mjs'],
])

export async function resolve(specifier, context, nextResolve) {
  const rel = STUBS.get(specifier)
  if (rel) return { url: new URL(rel, import.meta.url).href, shortCircuit: true }
  return nextResolve(specifier, context)
}
