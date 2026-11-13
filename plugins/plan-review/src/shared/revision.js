// What changed between two revisions of a plan, block by block, as hunks the page highlights and steps through.

/**
 * @typedef {{ blocks: string[], before: string[], after: string | null }} Hunk
 * `blocks`: ids of the new revision's added or rewritten blocks; `before`: the previous revision's text they replace
 * (or that was removed); `after`: for a pure removal, the id of the block it followed (null at the top).
 */

/** @returns {Hunk[]} in document order */
export function compareRevisions(previous, current) {
  const n = previous.length;
  const m = current.length;
  // lcs[i][j]: length of the longest common key sequence of previous[i..] and current[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = previous[i].key === current[j].key ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks = [];
  let hunk = null;
  let last = null;
  const flush = () => {
    if (hunk) hunks.push(hunk);
    hunk = null;
  };
  const open = () => (hunk ??= { blocks: [], before: [], after: last });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && previous[i].key === current[j].key) {
      flush();
      last = current[j++].id;
      i++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      open().blocks.push(current[j].id);
      last = current[j++].id;
    } else {
      open().before.push(previous[i++].text);
    }
  }
  flush();
  return hunks;
}
