// lib/client.js — restrict-discipline 设置卡片（浏览器半边）的 bundle 产物。
//
// DSH 的 client-modules 会原样提供本文件，因此它必须自注册：
// window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ... })
// factory 通过 require() 取依赖（react 等由宿主提供），并以 exports.* 导出插件。
//
// 功能：在 设置 → 插件（settings.plugin.item）注册一张卡片，显示“启用/禁用”
// 开关，写入 host 端 restrict-discipline 命名空间的 enabled 字段。
window.__ModuleLoader__.load({
  id: 'restrict-discipline',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var react = require('react');
    var createElement = react.createElement;
    var useSyncExternalStore = react.useSyncExternalStore;

    var CARD_STYLE = {
      border: '1px solid var(--dsw-border, #e5e7eb)',
      borderRadius: '8px',
      padding: '12px 14px',
      margin: '8px 0',
      display: 'block',
      listStyle: 'none',
    };
    var ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '8px' };
    var TITLE_STYLE = { fontWeight: 600, fontSize: '14px' };
    var DESC_STYLE = { color: 'var(--dsw-fg-muted, #6b7280)', fontSize: '12px', marginTop: '2px' };
    var META_STYLE = Object.assign({}, DESC_STYLE, { marginTop: '6px' });

    function Card(props) {
      var scope = props.scope;
      var snap = useSyncExternalStore(
        function (cb) { return scope.subscribe(cb); },
        function () { return scope.getSnapshot(); },
      );
      var value = snap && snap.value;
      var enabled = value && typeof value.enabled === 'boolean' ? value.enabled : true;
      var status = snap ? snap.status : 'loading';
      var writable = snap ? snap.writable : false;

      var toggle = function (event) {
        var next = Boolean(event.target.checked);
        scope.set('enabled', next).catch(function () {});
      };

      var statusText = status === 'unavailable'
        ? '命名空间不可用（host 插件未加载？）'
        : status === 'loading'
          ? '加载中…'
          : writable
            ? '已启用' + (enabled ? '：规则生效中' : '：全部规则已暂停')
            : '只读（当前设置不可写）';

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
          '四元行为规范（强制约束/Token 节约/会话记忆/编码纪律）：禁止项目根目录建文件、保护根目录 .env、禁止修改代理设置、目录外修改需确认、操作留痕，以及 memory/*.md Markdown 记忆库（remember/recall/export/GC）。',
        ),
        createElement('div', { style: META_STYLE }, statusText),
      );
    }

    function apply(ctx) {
      var slots = ctx.get('slots');
      var binder = ctx.get('settingsScope');
      if (slots === undefined || binder === undefined) return;
      var scope = binder.bind({ namespace: 'restrict-discipline' });
      if (typeof scope.load === 'function') void scope.load();
      ctx.effect(function () {
        return slots.inject('settings.plugin.item', function () {
          return slots.register(
            { name: 'settings.plugin.item', id: 'restrict-discipline', order: 30 },
            function (props) { return createElement(Card, Object.assign({}, props, { scope: scope })); },
          );
        });
      }, 'restrict-discipline: settings card');
    }

    exports.apply = apply;
    exports.inject = ['slots', 'settingsScope'];
    return module.exports;
  }
});
