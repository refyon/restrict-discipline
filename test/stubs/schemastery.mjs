// test/stubs/schemastery.mjs — @deepseek-ai/schemastery 最小桩（CI 零依赖用）。
// lib/index.js 顶层用 z.object({ ...: z.boolean().default(...) }) 构建 Schema，仅作为
// 注册时的默认值对象，集成测试的 mock settings 不校验其结构；链式方法返回自身即可。
const chainable = () => {
  const t = (..._args) => t
  t.default = () => t
  t.required = () => t
  t.optional = () => t
  return t
}

export default { object: (def) => def, boolean: chainable, number: chainable }
