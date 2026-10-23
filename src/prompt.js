/**
 * 从消息内容里取纯文本。
 *
 * 新事件是 PromptContentPart[]，与宿主 contentParts() 同构：只拼 type==='text' 的段。
 * 旧会话（插件安装之前就写进日志的事件）可能把内容直接存成字符串，那种也必须读得出文本，
 * 否则旧消息既没有重试图标、也进不了输入历史。
 * 图片/文件附件不参与——重发只重发文本，把附件再传一遍等于二次上传。
 * 引用 chip 在内容里本来就是内联文本（形如 @src/a.js），原样保留即可。
 *
 * @param {unknown} content - 消息内容（内容段数组、纯字符串或缺失）
 * @returns {string}
 */
export function extractPromptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

/**
 * 判断一条事件是不是「用户自己发的一句对话」。
 *
 * 与宿主内置 input-message 的判定同口径（ui-chat 的 messageDefinition.match），但对旧会话宽松：
 * 插件安装之前产生的事件可能完全没有 surfaceOp、没有 data.source、没有 data.id，
 * 一律按「用户追加发送」处理——否则旧对话里的旧消息永远拿不到重试图标（用户实测的缺陷）。
 * 保留的两条硬条件：type 必须是 user/message，data 必须是对象。
 *
 * @param {unknown} event - 会话事件
 * @returns {boolean}
 */
export function isUserPromptEvent(event) {
  if (event === null || typeof event !== 'object') return false;
  if (event.type !== 'user/message') return false;
  // 只有显式的替换副本才排除：压缩检查点、被改写的历史都不是用户当时看到的那条
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return false;
  const data = event.data;
  if (data === null || typeof data !== 'object') return false;
  // 工具注入的上下文（tool-registry / runtime-context）不是「用户发的话」，必须挡住；
  // 旧事件根本没有 source 字段，缺失按用户消息放行
  const source = data.source;
  if (source !== null && typeof source === 'object' && source.kind !== undefined && source.kind !== 'user') return false;
  return true;
}

/**
 * 事件身份：新事件用 data.id，旧事件没有 id 时退回 seq。
 *
 * 必须是稳定值——宿主拿它拼 context key，同一事件两次匹配给出不同 id 会每次都造一个新 context。
 *
 * @param {unknown} event - 会话事件
 * @returns {string|null} 拿不到稳定身份时返回 null
 */
export function userPromptIdOf(event) {
  const data = event === null || typeof event !== 'object' ? undefined : event.data;
  const id = data === null || typeof data !== 'object' ? undefined : data.id;
  if (id !== null && id !== undefined) return String(id);
  const seq = event === null || typeof event !== 'object' ? undefined : event.seq;
  return typeof seq === 'number' ? 'seq-' + seq : null;
}

/**
 * 用户消息的纯文本：重试图标与输入历史回填共用这一份提取口径。
 *
 * @param {unknown} event - 会话事件
 * @returns {string} 不是用户消息时返回空串
 */
export function userPromptTextOf(event) {
  if (isUserPromptEvent(event) === false) return '';
  return extractPromptText(event.data.content);
}
