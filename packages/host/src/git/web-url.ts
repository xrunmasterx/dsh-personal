/** Git evidence projection migrated from ai-workflow. */
const GONGFENG_HOSTS = new Set(['code.tencent.com', 'git.code.tencent.com', 'git.tencent.com', 'git.woa.com'])

function isGongfengHost(hostname: string): boolean {
  return GONGFENG_HOSTS.has(hostname) || hostname.endsWith('.git.woa.com')
}

/**
 * Construct a commit link only when repository hosting has a known web form.
 * @param repositoryWebUrl - normalized repository web URL, when known.
 * @param sha - full commit identity.
 * @returns the hosting URL, or undefined when the repository has no recognized web form.
 */
export function buildCommitWebUrl(repositoryWebUrl: string | null | undefined, sha: string): string | undefined {
  if (!repositoryWebUrl || !/^[a-f0-9]{40,64}$/i.test(sha)) return undefined

  try {
    const url = new URL(repositoryWebUrl)
    const hostname = url.hostname.toLowerCase()
    const repositoryPath = url.pathname.replace(/\/+$/, '')
    if (!repositoryPath) return undefined

    if (isGongfengHost(hostname)) {
      return `${url.origin}${repositoryPath}/commit/${sha}`
    }
    return undefined
  } catch {
    return undefined
  }
}
