// lib/client.js — restrict-discipline 设置卡片（浏览器半边）。
//
// 在 设置 → 插件（settings.plugin.item）注册一张卡片：显示“启用/禁用”开关，
// 写入 host 端的 restrict-discipline 命名空间（enabled 字段）。纯 React（无 JSX），
// 用 useSyncExternalStore 订阅 settings scope 快照。

import { createElement, useSyncExternalStore } from 'react'

export const name = 'restrict-discipline-client'
export const inject = ['slots', 'settingsScope']

export function apply(ctx) {
  const slots = ctx.get('slots')
  const binder = ctx.get('settingsScope')
  if (slots === undefined || binder === undefined) return
  const scope = binder.bind({ namespace: 'restrict-discipline' })
  void scope.load()
  ctx.effect(() => slots.inject('settings.plugin.item', () => slots.register(
    { name: 'settings.plugin.item', id: 'restrict-discipline', order: 30 },
    (props) => createElement(Card, { ...props, scope }),
  )))
}

const CARD_STYLE = {
  border: '1px solid var(--dsw-border, #e5e7eb)',
  borderRadius: '8px',
  padding: '12px 14px',
  margin: '8px 0',
  display: 'block',
  listStyle: 'none',
}
const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '8px' }
const TITLE_STYLE = { fontWeight: 600, fontSize: '14px' }
const DESC_STYLE = { color: 'var(--dsw-fg-muted, #6b7280)', fontSize: '12px', marginTop: '2px' }
const META_STYLE = { ...DESC_STYLE, marginTop: '6px' }

function Card(props) {
  const scope = props.scope
  const snap = useSyncExternalStore(
    (cb) => scope.subscribe(cb),
    () => scope.getSnapshot(),
  )
  const value = snap && snap.value
  const enabled = value && typeof value.enabled === 'boolean' ? value.enabled : true
  const status = snap ? snap.status : 'loading'
  const writable = snap ? snap.writable : false

  const toggle = (event) => {
    const next = Boolean(event.target.checked)
    void scope.set('enabled', next).catch(() => {})
  }

  const statusText = status === 'unavailable'
    ? '命名空间不可用（host 插件未加载？）'
    : status === 'loading'
      ? '加载中…'
      : writable
        ? '已启用' + (enabled ? '：规则生效中' : '：全部规则已暂停')
        : '只读（当前设置不可写）'

  return createElement(
    'li',
    { style: CARD_STYLE },
    createElement('div', { style: ROW_STYLE },
      createElement('input', {
        type: 'checkbox',
        checked: enabled,
        disabled: status !== 'ready' || !writable,
        onChange: toggle,
        'aria-label': '启用 restrict-discipline 行为规范',
      }),
      createElement('span', { style: TITLE_STYLE }, 'restrict-discipline（行为规范）'),
    ),
    createElement('div', { style: DESC_STYLE },
      '禁止项目根目录建文件、保护根目录 .env、禁止修改代理设置、目录外修改需确认、操作留痕与会话摘要。',
    ),
    createElement('div', { style: META_STYLE }, statusText),
  )
}
