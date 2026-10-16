/** Bounded operational diagnostics shared by the Host and its isolated worker. */

/**
 * Remove credentials and signed remote URLs from persisted or displayed diagnostics.
 * @param text - external process or transport diagnostic.
 * @param limit - maximum retained characters.
 * @returns redacted bounded text.
 */
export function redactDiagnostic(text: string, limit: number): string {
  return text
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[remote URL]')
    .replace(
      // eslint-disable-next-line @stylistic/max-len -- Keep the credential assignment matcher as one auditable expression.
      /(["']?(?:authorization|access[-_ ]?token|refresh[-_ ]?token|api[-_ ]?key|secret|password)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/\bBearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .slice(0, limit)
}

/**
 * Classify a model failure while retaining its concrete, scrubbed reason.
 * @param detail - process failure text.
 * @returns actionable diagnostic for the failed task.
 */
export function modelFailure(detail: string): string {
  const safe = redactDiagnostic(detail, 1800)
  const label = /not inside a trusted|git.repo.check/i.test(safe)
    ? '工作目录未获准'
    : /401|unauthorized|authentication|login|credential|refresh.token/i.test(safe)
      ? 'Codex 登录不可用'
      : /model.*(?:not found|unsupported|not available)|model_not_found/i.test(safe)
        ? '模型不可用'
        : /rate.limit|429|usage.limit|quota/i.test(safe)
          ? '模型额度或请求频率受限'
          : /timed? ?out|timeout/i.test(safe)
            ? '模型执行超时'
            : /schema|invalid json|unexpected token|parse/i.test(safe)
              ? '模型结果格式不符合要求'
              : /connect|network|fetch failed|stream disconnected/i.test(safe)
                ? '模型连接失败'
                : '模型执行失败'
  return `${label}：${safe || '执行进程未返回诊断信息'}`
}
