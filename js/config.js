// DEPLOYMENT CONFIG
// -----------------------------------------------------------------------------
// The only thing in this app that depends on where it is hosted: the links from
// Doctor findings to the book chapters that explain them.
//
// Everything else is self-contained — no network calls, no external assets — so
// the simulator itself runs from any static host (GitHub Pages, S3, nginx).

export const CONFIG = {
  /**
   * Where the book chapters live.
   *
   *   'auto'  – use the sibling ../system-design-book/ folder when served from a
   *             repo root; on *.github.io, rewrite to github.com/blob/ URLs so
   *             the markdown renders instead of downloading as plain text.
   *   'none'  – no book available: chapter references render as plain labels
   *             rather than broken links. Use this if you publish the simulator
   *             on its own without the book.
   *   any URL – an explicit base, e.g.
   *             'https://github.com/you/system-design-handbook/blob/main/system-design-book/'
   */
  bookBase: 'https://github.com/nerdyheisenberg/system-design-handbook/blob/main/',

  /** Branch to use when building github.com blob URLs under 'auto'. */
  githubBranch: 'main',
};

/**
 * GitHub Pages cannot render .md files: with Jekyll enabled they are rewritten
 * to .html, and with .nojekyll they are served as plain text. Either way the
 * relative link breaks, so on Pages we point at github.com, which renders them.
 *
 * Pure so it can be tested against any hostname/path combination.
 */
export function resolveBookBase(config, loc) {
  if (config.bookBase === 'none') return null;
  if (config.bookBase !== 'auto') return config.bookBase;

  const { hostname, pathname } = loc;
  if (!hostname.endsWith('.github.io')) return '../system-design-book/';

  const owner = hostname.slice(0, -'.github.io'.length);
  const segments = pathname.split('/').filter(Boolean);
  // On Pages the first path segment is the project repo; only the bare root is
  // the special <owner>.github.io repo. If you instead deploy this *inside* an
  // <owner>.github.io repo, set bookBase explicitly — that case is ambiguous.
  const repo = segments.length ? segments[0] : `${owner}.github.io`;
  return `https://github.com/${owner}/${repo}/blob/${config.githubBranch}/system-design-book/`;
}

let cached;
export function bookBase() {
  if (cached === undefined) cached = resolveBookBase(CONFIG, window.location);
  return cached;
}
