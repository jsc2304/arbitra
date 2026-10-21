/**
 * Single source of truth for Arbitra's user-facing version metadata.
 *
 *   1. Release label shown in the footer
 *   2. Product build (CalVer: YYYY.M.patch)
 *   3. HTTP API version (unversioned paths, additive changes only)
 *   4. Spec doc generation (separate from product build)
 *
 * `arbitra-mcp` (`packages/mcp`) follows its own SemVer.
 */

export const ARBITRA_BUILD = '2026.10.0';
export const ARBITRA_STAGE = 'open-source';
export const ARBITRA_STAGE_LABEL = 'Open Source';
export const ARBITRA_SPEC_VERSION = 'v1.0';
export const ARBITRA_API_VERSION = 'v1';
