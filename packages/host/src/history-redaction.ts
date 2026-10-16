/** Credential removal applied before retaining or analyzing external conversation text. */

/**
 * Remove recognized credential literals and explicitly labelled secret values.
 * @param text - untrusted message, summary or diagnostic text.
 * @returns text with secret values replaced, preserving surrounding prose.
 */
export function redactHistory(text: string): string {
  return text
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|ck_[A-Za-z0-9._-]{20,}|AIza[A-Za-z0-9_-]{25,}|tvly-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/((?:api[ _-]?key|authorization|access[ _-]?token|password|密钥|密码)\s*["']?\s*(?:[=:：]|是|为)\s*["']?)(?:Bearer\s+)?[^\s,"';<>\\]+/gi, '$1[redacted]')
}
