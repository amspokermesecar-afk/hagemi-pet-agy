// Turns conversation events into desktop system notifications, respecting focus and user toggles.
import { scrub } from './persona.mjs';

export const MAX_TITLE = 30;
export const MAX_BODY = 80;

export function truncate(text, limit = MAX_BODY) {
  if (!text) return '';
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  const points = Array.from(cleaned);
  return points.length > limit ? `${points.slice(0, limit).join('')}…` : cleaned;
}

function sessionTitleOf(title) {
  const value = String(title || '').trim();
  return value ? truncate(value, MAX_TITLE) : '';
}

function composeTitle(title, label) {
  const name = sessionTitleOf(title);
  return name ? `${name} · ${label}` : label;
}

function cleanExcerpt(text, limit = MAX_BODY) {
  if (!text) return '';
  const plain = String(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~#>]+/g, ' ');
  return truncate(scrub(plain, limit + 20), limit);
}

export function buildNotification(event, { language = 'zhs', settings = {}, focused = false } = {}) {
  if (!event || !event.type) return null;
  const zh = language === 'zhs';
  const cfg = settings?.notifications || {};
  const isTest = event.type === 'test';

  if (!isTest && cfg.enabled === false) return null;
  if (!isTest && cfg.whenFocused === false && focused) return null;

  const conversationId = typeof event.id === 'string' && event.id ? event.id : null;
  const conversationTitle = typeof event.title === 'string' ? event.title : '';

  switch (event.type) {
    case 'turn_done':
    case 'turn_done_big': {
      if (cfg.onDone === false) return null;
      const body = cleanExcerpt(event.agentText, MAX_BODY)
        || (zh ? '任务已完成，点一下回到对应会话。' : 'Task finished. Click to return to the conversation.');
      return {
        kind: 'done',
        title: sessionTitleOf(conversationTitle) || (zh ? '任务已完成' : 'Task completed'),
        body,
        conversationId,
        conversationTitle,
      };
    }
    case 'turn_error':
    case 'turn_maxed': {
      if (cfg.onDone === false) return null;
      const label = event.type === 'turn_maxed'
        ? (zh ? '达到步数上限' : 'Step limit reached')
        : (zh ? '任务出错' : 'Task error');
      const body = cleanExcerpt(event.agentText, MAX_BODY)
        || (event.type === 'turn_maxed'
          ? (zh ? '代理已达到最大步数限制，点一下查看详情。' : 'Agent hit the step limit. Click to inspect.')
          : (zh ? '代理执行时遇到错误，点一下回到会话查看。' : 'Agent stopped with an error. Click to inspect.'));
      return {
        kind: 'error',
        title: composeTitle(conversationTitle, label),
        body,
        conversationId,
        conversationTitle,
      };
    }
    case 'waiting_start': {
      if (cfg.onWaiting === false) return null;
      return {
        kind: 'waiting',
        title: composeTitle(conversationTitle, zh ? '需要确认' : 'Input needed'),
        body: zh
          ? '代理正在等待你的确认或回复，点一下回到会话。'
          : 'Agent is waiting for your confirmation or reply. Click to return.',
        conversationId,
        conversationTitle,
      };
    }
    case 'test':
      return {
        kind: 'test',
        title: zh ? '哈基米桌宠' : 'Hagemi Pet',
        body: zh
          ? '系统通知已就绪，点一下回到 Antigravity！'
          : 'System notifications are ready. Click to return to Antigravity!',
        conversationId,
        conversationTitle,
      };
    default:
      return null;
  }
}
