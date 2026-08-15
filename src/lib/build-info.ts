/**
 * Build profile marker (inlined into the bundle at build time).
 *
 * `false` for community / self-built copies: they run with NO license-activation
 * gate, so anyone may build from source and use Vek-Snap for free (personal,
 * noncommercial use: see LICENSE). The official signed release is produced by a
 * separate, private build pipeline that sets this to `true`, which enables the
 * one-time activation step for the paid distribution.
 *
 * Because the value is compiled in at build time, it is not a runtime or
 * environment-variable toggle.
 */
export const OFFICIAL_BUILD = false;
