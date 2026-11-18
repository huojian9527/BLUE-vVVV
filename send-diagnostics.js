import { AppError } from './store.js';

// Only fixed public categories leave the server; raw WhatsApp errors may contain
// message text, destinations, URLs or browser data.
export function messageSendFailure(error) {
  const text = String(error?.message || '');
  let code = 'WHATSAPP_SEND_FAILED', status = 502, message = 'WhatsApp 发送失败，请查看接收诊断中的发送错误代码';
  if (error?.code === 'SEND_TIMEOUT' || /timeout|timed out/i.test(text)) {
    code = 'WHATSAPP_SEND_TIMEOUT'; status = 504; message = 'WhatsApp 发送超时，是否送达尚未确认，请勿连续重发';
  } else if (error?.code === 'SEND_BROWSER_CLOSED' || /target closed|session closed|execution context was destroyed|browser.*disconnected/i.test(text)) {
    code = 'WHATSAPP_SEND_DISCONNECTED'; status = 503; message = 'WhatsApp 浏览器连接已失效，请等待号码重新连接后再试';
  } else if (error?.code === 'SEND_NO_ID') {
    code = 'WHATSAPP_SEND_NO_ID'; message = 'WhatsApp 未返回消息编号，是否送达尚未确认，请勿连续重发';
  } else if (/is not a function|is not defined|cannot read propert|module.*not.*found|MsgKey|_serialized/i.test(text)) {
    code = 'WHATSAPP_SEND_INCOMPATIBLE'; message = 'WhatsApp 网页接口发生变化，当前发送接口不兼容，请检查服务版本并重新连接号码';
  }
  // Extract identifier-shaped API names only, never the complete exception text.
  const target = /\b((?:[A-Za-z_$][\w$]*\.){0,5}[A-Za-z_$][\w$]*)\)? is not a function\b/.exec(text)?.[1]
    || /\b([A-Za-z_$][\w$]*) is not defined\b/.exec(text)?.[1]
    || /module not found:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,5})/i.exec(text)?.[1];
  const safeTarget = target && target.length <= 100 ? target : null;
  const failure = new AppError(status, `${message}（${code}${safeTarget ? `；API: ${safeTarget}` : ''}）`);
  if (safeTarget) failure.target = safeTarget;
  failure.publicCode = code;
  // A property name helps identify changed APIs without logging raw exceptions.
  const property = /reading ['"]([A-Za-z_$][\w$]{0,59})['"]/.exec(text)?.[1];
  if (property) failure.property = property;
  return failure;
}
export function sentRecordFailure() {
  const error = new AppError(503, '消息已提交，但本地保存或刷新失败，请勿重复发送；请检查服务存储（SEND_RECORD_FAILED）');
  error.publicCode = 'SEND_RECORD_FAILED';
  return error;
}
