/**
 * 剪贴板写入：插件里唯一允许碰 document 的地方。
 *
 * 宿主自己的复制按钮走 primitives 的 writeClipboard（web shell @660099），而插件被明令禁止
 * import primitives，只能把那段行为抄过来：优先 navigator.clipboard.writeText，
 * 不可用再回落「临时 textarea + document.execCommand('copy')」。
 *
 * 回落路径用 document，但只是瞬时建一个离屏 textarea、复制完立刻移除：
 * 不常驻、不读也不改宿主的任何 DOM 节点。scripts/check.mjs 的 document. 禁令只对本文件放行，
 * 其它文件照旧全禁——放行范围收到一个文件、一个用途，是为了不让「复制」这种小功能
 * 把整条 DOM 红线拆掉。
 */

/**
 * 把文本写进剪贴板。
 *
 * 任何失败都只回 false，不抛：复制失败不该炸掉消息行，也不该让用户以为复制成功了。
 *
 * @param {string} text - 要写入的文本
 * @returns {Promise<boolean>} 是否真的写进去了
 */
export function writeClipboardText(text) {
  const value = typeof text === 'string' ? text : '';
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const clipboard = nav === null || nav === undefined ? undefined : nav.clipboard;
  if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === 'function') {
    try {
      // 异步 API 也可能被策略拒绝（非安全上下文、无用户手势），拒绝时再走回落
      return Promise.resolve(clipboard.writeText(value)).then(
        () => true,
        () => copyByTextarea(value),
      );
    } catch (error) {
      return Promise.resolve(copyByTextarea(value));
    }
  }
  return Promise.resolve(copyByTextarea(value));
}

/**
 * 回落复制：临时 textarea + execCommand。
 *
 * @param {string} value - 要写入的文本
 * @returns {boolean} 是否复制成功
 */
function copyByTextarea(value) {
  // 非浏览器环境（node --test 的 vm 沙箱）没有 document：直接判定复制不可用
  if (typeof document === 'undefined' || document === null) return false;
  if (typeof document.execCommand !== 'function') return false;
  let area;
  try {
    area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    return document.execCommand('copy') === true;
  } catch (error) {
    return false;
  } finally {
    if (area !== undefined && typeof area.remove === 'function') area.remove();
  }
}
