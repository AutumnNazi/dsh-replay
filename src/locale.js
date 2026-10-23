export const LOCALES = Object.freeze({
  zh: Object.freeze({
    'brand.name': '回言',
    'brand.description': '按会话回翻输入历史，或将用户消息原样追加重发。',
    'component.history.name': '输入历史',
    'component.history.description': '用 ↑/↓ 回翻当前会话的输入历史，保留草稿与原生光标行为。',
    'component.retry.name': '消息重试',
    'component.retry.description': '在用户消息操作行追加重试按钮，重发到对话末尾，不改动已有对话。',
    'copy.label': '复制',
    'copy.done': '已复制',
    'copy.title': '复制这条消息',
    'retry.failure': '重发失败',
    'retry.empty': '这条消息没有可重发的文本',
    'retry.unavailable': '会话不可用，无法重发',
    'retry.disabled': '消息重试组件已停用',
    'retry.label': '重试这条消息',
    'retry.busy': '正在生成回答，等这一轮结束后再重发',
    'retry.sending': '正在重发…',
    'retry.title': '把这条消息再发一次：追加到对话末尾，已有对话一字不动',
    'clock.md': '{m}月{d}日',
    'clock.ymd': '{y}年{m}月{d}日',
    'history.prev': '上一条输入',
    'history.next': '下一条输入',
    'history.missingSession': '[dsh-replay] composer.dock 槽位没有拿到 sessionId，输入历史在该会话不可用',
    'history.unavailable': '会话还没有打开，读不到历史',
    'history.pageFailed': '[dsh-replay] 向上翻页读取更早历史失败，只用已加载部分：{sessionId}',
    'history.hydrated': '[dsh-replay] 会话历史回填',
    'history.draftChanged': '[dsh-replay] 退出回翻：草稿与上次写入不一致',
    'history.unregisterFailed': '[dsh-replay] 解注册失败',
    'history.fixedFailed': '[dsh-replay] 快捷键清单声明失败',
    'history.readFailed': '[dsh-replay] 读取会话历史失败，该会话退回只记插件运行期间的输入：{sessionId}',
    'history.loadMoreFailed': '[dsh-replay] 加载更早的会话历史失败：{sessionId}',
    'history.moreFailed': '[dsh-replay] 加载更早的会话历史失败：{sessionId}',
    'history.mountFailed': '[dsh-replay] 输入历史装配失败',
    'composer.shellFailed': '[dsh-replay] 解析输入外壳失败，输入历史在该会话不可用',
    'composer.snapshotFailed': '[dsh-replay] 读取草稿快照失败，回车记历史暂停',
    'composer.unsubscribeFailed': '[dsh-replay] 解订阅失败',
    'composer.subscribeFailed': '[dsh-replay] 订阅草稿快照失败，回车记历史在该会话暂停',
    'composer.readFailed': '[dsh-replay] 读取草稿失败',
    'composer.writeFailed': '[dsh-replay] 写回草稿失败',
  }),
  en: Object.freeze({
    'brand.name': 'Re:Play',
    'brand.description': 'Recall per-session input history or resend user messages by appending them unchanged.',
    'component.history.name': 'Input history',
    'component.history.description': 'Use ↑/↓ to recall input history in the current session while preserving drafts and native cursor behavior.',
    'component.retry.name': 'Prompt Replay',
    'component.retry.description': 'Add a retry action to user messages and resend at the end without changing the existing conversation.',
    'copy.label': 'Copy',
    'copy.done': 'Copied',
    'copy.title': 'Copy this message',
    'retry.failure': 'Resend failed',
    'retry.empty': 'This message has no text to resend',
    'retry.unavailable': 'The session is unavailable; cannot resend',
    'retry.disabled': 'The message retry component is disabled',
    'retry.label': 'Retry this message',
    'retry.busy': 'A response is being generated. Wait for this turn to finish before resending',
    'retry.sending': 'Resending…',
    'retry.title': 'Send this message again: append it to the end, leaving the existing conversation unchanged',
    'clock.md': '{m}/{d}',
    'clock.ymd': '{y}-{m}-{d}',
    'history.prev': 'Previous input',
    'history.next': 'Next input',
    'history.missingSession': '[dsh-replay] composer.dock did not provide sessionId; input history is unavailable in this session',
    'history.unavailable': 'The session is not open; history is unavailable',
    'history.pageFailed': '[dsh-replay] Failed to read older history; using only loaded entries: {sessionId}',
    'history.hydrated': '[dsh-replay] Session history hydrated',
    'history.draftChanged': '[dsh-replay] Stopped history recall: the draft no longer matches the last written value',
    'history.unregisterFailed': '[dsh-replay] Failed to unregister',
    'history.fixedFailed': '[dsh-replay] Failed to declare fixed shortcuts',
    'history.readFailed': '[dsh-replay] Failed to read session history; recording only inputs made while the plugin is running: {sessionId}',
    'history.loadMoreFailed': '[dsh-replay] Failed to load older session history: {sessionId}',
    'history.moreFailed': '[dsh-replay] Failed to load older session history: {sessionId}',
    'history.mountFailed': '[dsh-replay] Failed to mount input history',
    'composer.shellFailed': '[dsh-replay] Failed to resolve the input shell; input history is unavailable in this session',
    'composer.snapshotFailed': '[dsh-replay] Failed to read the draft snapshot; recording history on Enter is paused',
    'composer.unsubscribeFailed': '[dsh-replay] Failed to unsubscribe',
    'composer.subscribeFailed': '[dsh-replay] Failed to subscribe to draft snapshots; recording history on Enter is paused in this session',
    'composer.readFailed': '[dsh-replay] Failed to read the draft',
    'composer.writeFailed': '[dsh-replay] Failed to restore the draft',
  }),
});

function languageOf(language) {
  return typeof language === 'string' && /^zh(?:-|$)/i.test(language) ? 'zh-CN' : 'en-US';
}

export function translateReplay(key, language, params) {
  const dict = languageOf(language) === 'zh-CN' ? LOCALES.zh : LOCALES.en;
  const template = Object.hasOwn(dict, key) ? dict[key] : key;
  return interpolate(template, params);
}

function interpolate(template, params) {
  return params ? template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match) : template;
}

export function createReplayI18n(locale) {
  if (locale != null) {
    for (const method of ['getSnapshot', 'resolveText', 'subscribe']) {
      if (typeof locale[method] !== 'function') throw new TypeError(`Replay locale requires ${method}()`);
    }
  }
  const language = () => languageOf(locale?.getSnapshot().active);
  const stops = new Set();
  let disposed = false;
  return {
    t(key, params) {
      if (!Object.hasOwn(LOCALES.en, key)) return key;
      if (!locale) return translateReplay(key, language(), params);
      return interpolate(locale.resolveText({ zh: LOCALES.zh[key], en: LOCALES.en[key] }), params);
    },
    language,
    subscribe(fn) {
      if (disposed) throw new Error('Replay i18n is disposed');
      if (!locale) return () => {};
      const hostOff = locale.subscribe(() => fn());
      const stop = () => {
        if (!stops.has(stop)) return;
        hostOff();
        stops.delete(stop);
      };
      stops.add(stop);
      return stop;
    },
    dispose() {
      disposed = true;
      for (const stop of stops) stop();
    },
  };
}
