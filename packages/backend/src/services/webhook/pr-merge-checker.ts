import { parsePrRef } from '@arbitra/shared';
/**
 * Checks GitHub API for PR merge status.
 * Used as a fallback when GitHub webhooks aren't configured
 * (e.g., local development, demo mode).
 */
export class PrMergeChecker {
  private readonly token: string | undefined;

  constructor(token?: string) {
    this.token = token ?? process.env.GITHUB_TOKEN;
  }

  async checkPrMergeStatus(
    prUrl: string,
  ): Promise<{ merged: boolean; merged_at?: string } | null> {
    const parsed = this.parsePrUrl(prUrl);
    if (!parsed) return null;

    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Arbitra/1.0',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        console.error(
          `[PrMergeChecker] GitHub API returned ${response.status} for ${parsed.owner}/${parsed.repo}#${parsed.number}`,
        );
        return null;
      }

      const data = (await response.json()) as { merged?: boolean; merged_at?: string | null };
      return {
        merged: data.merged === true,
        merged_at: data.merged_at ?? undefined,
      };
    } catch (error) {
      console.error('[PrMergeChecker] Failed to check PR status:', error);
      return null;
    }
  }

  /**
   * Delegates to the one shared PR-ref parser (issue #1046). The
   * private copy this replaces was UNANCHORED — the same crafted-URL
   * confusion issue #1032 (M1) fixed in `diff-resolver.ts` was still live
   * here, so `https://evil.example/?x=github.com/acme/demo/pull/1` resolved
   * to a legitimate-looking `acme/demo` PR.
   */
  private parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
    return parsePrRef(url);
  }
}
