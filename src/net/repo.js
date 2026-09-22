/**
 * Where a team's op-modes come from.
 *
 * ## Three ways in, because a team has three situations
 *
 * A teammate's JVM simulator points at a checkout with `-Prepo` and compiles
 * the op-modes it finds. That is the right model and this keeps it, in the
 * three forms a browser can manage:
 *
 *  - **A checkout on this machine.** `npm start -- --repo ../FtcRobotController`
 *    (or nothing at all, if the checkout is a sibling directory -- the server
 *    looks). Closest to `-Prepo`: no network, no sign-in, and editing a file in
 *    your IDE and pressing Reload here picks it up.
 *  - **A GitHub repository.** `owner/repo`, optionally `#branch`. For a laptop
 *    that has the browser but not the checkout, and for showing somebody your
 *    auto without sending them a file.
 *  - **A folder you pick or drop.** No server flag and no network. Chromium can
 *    hand a page a directory; everything else can at least take dropped files.
 *
 * ## What counts as an op-mode file
 *
 * Every `.java` under the tree, minus the SDK's own sample and internal
 * directories -- `external/samples` is 40 files of examples that would bury a
 * team's own four, and `FtcRobotController/src` is the app itself. What is left
 * is compiled together, because an op-mode references its team's helpers.
 *
 * There is a size cap. A repository is mostly not Java, and a page that
 * cheerfully downloaded 200 MB of Gradle caches would deserve what it got.
 *
 * @module
 */

/** How many files, and how much of them, to take from a repository. */
export const REPO_LIMITS = Object.freeze({
  maxFiles: 200,
  maxBytes: 4 * 1024 * 1024,
  maxFileBytes: 512 * 1024,
});

/**
 * Directories that are not a team's code.
 *
 * `external/samples` is the SDK's own examples: genuinely useful, and 40 of
 * them next to a team's four would make the op-mode list useless. They can be
 * loaded on purpose with `includeSamples`.
 */
/** Never wanted: generated output and machinery. */
const HARD_SKIP = [
  /(^|\/)build(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.gradle(\/|$)/,
  /(^|\/)\.idea(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)libs?(\/|$)/,
];

/** Not a team's code: the app itself, Blocks, and the test sources. */
const SKIP = [
  /(^|\/)FtcRobotController\/src\//,
  /(^|\/)Blocks(\/|$)/,
  /(^|\/)test(s)?(\/|$)/,
];

const SAMPLES = /(^|\/)(external\/samples|samples)(\/|$)/;

/**
 * Is this a file worth compiling?
 *
 * The samples are checked before the general exclusions, because they live
 * *inside* `FtcRobotController/src` -- so testing the exclusions first would
 * make `includeSamples` impossible to honour, which is exactly what it did.
 *
 * @param {string} path
 * @param {{includeSamples?: boolean}} [opts]
 */
export function isTeamJavaFile(path, opts = {}) {
  if (!/\.java$/i.test(path)) return false;
  if (HARD_SKIP.some((pattern) => pattern.test(path))) return false;
  if (SAMPLES.test(path)) return Boolean(opts.includeSamples);
  if (SKIP.some((pattern) => pattern.test(path))) return false;
  return true;
}

/**
 * Trim a list of candidate files to the limits, keeping the most likely ones.
 *
 * Sorted so that anything mentioning an op-mode annotation comes first, then
 * shallower paths -- because `TeamCode/src/.../Auto.java` matters more than the
 * tenth utility class, and if something has to be dropped it should be the
 * utility.
 *
 * @param {Array<{path: string, size?: number}>} files
 * @param {{includeSamples?: boolean}} [opts]
 */
export function chooseRepoFiles(files, opts = {}) {
  const wanted = files
    .filter((f) => isTeamJavaFile(f.path, opts))
    .filter((f) => (f.size ?? 0) <= REPO_LIMITS.maxFileBytes)
    .sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  const out = [];
  let bytes = 0;
  const skipped = [];
  for (const file of wanted) {
    if (out.length >= REPO_LIMITS.maxFiles || bytes + (file.size ?? 0) > REPO_LIMITS.maxBytes) {
      skipped.push(file.path);
      continue;
    }
    out.push(file);
    bytes += file.size ?? 0;
  }
  return { files: out, skipped };
}

function depth(path) {
  return path.split('/').length;
}

/** A short name for a path, which is what the op-mode list shows. */
export function shortName(path) {
  return String(path).split('/').pop() ?? path;
}

// ---------------------------------------------------------------- the sources

/**
 * A checkout on the machine serving this page.
 *
 * The server does the walking, because a browser cannot read a directory it was
 * not handed. `--repo` points at one; with no flag the server looks for a
 * sibling checkout, which is where a team's repository usually is.
 *
 * @param {{fetch?: typeof fetch}} [opts]
 * @returns {Promise<{root: string, files: Array<{name: string, path: string, source: string}>, skipped: string[]}>}
 */
export async function loadLocalRepo(opts = {}) {
  const get = opts.fetch ?? globalThis.fetch;
  const response = await get('/repo/files');
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      response.status === 404
        ? 'This page is not being served with a repository attached. ' +
          'Restart it with:  npm start -- --repo ../your-FtcRobotController'
        : `the server said ${response.status} ${detail}`.trim(),
    );
  }
  const body = await response.json();
  return { root: body.root, files: body.files, skipped: body.skipped ?? [] };
}

/**
 * A GitHub repository, over the public API.
 *
 * One call for the tree and one per file. No token, so it is public
 * repositories only and the rate limit is 60 an hour -- which is plenty for a
 * team loading their own repository a few times, and the error says so when it
 * is not.
 *
 * @param {string} spec `owner/repo`, or `owner/repo#branch`, or a github.com URL
 * @param {{fetch?: typeof fetch, includeSamples?: boolean}} [opts]
 */
export async function loadGitHubRepo(spec, opts = {}) {
  const get = opts.fetch ?? globalThis.fetch;
  const target = parseRepoSpec(spec);
  if (!target) {
    throw new Error(`"${spec}" is not a repository. Try owner/repo, or owner/repo#branch.`);
  }
  const { owner, repo } = target;
  let branch = target.branch;

  if (!branch) {
    const meta = await json(get, `https://api.github.com/repos/${owner}/${repo}`);
    branch = meta.default_branch ?? 'main';
  }
  const tree = await json(
    get,
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  if (tree.truncated) {
    // A tree big enough to truncate has far more in it than op-modes, and the
    // ones we want are usually early, so this is a note rather than a failure.
    opts.onNote?.('the repository is large, so only part of its file list was returned');
  }
  const candidates = (tree.tree ?? [])
    .filter((entry) => entry.type === 'blob')
    .map((entry) => ({ path: entry.path, size: entry.size ?? 0 }));
  const chosen = chooseRepoFiles(candidates, opts);
  if (chosen.files.length === 0) {
    throw new Error(`no team Java files found in ${owner}/${repo} on ${branch}`);
  }

  const files = [];
  for (const file of chosen.files) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${file.path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const response = await get(url);
    if (!response.ok) continue;
    files.push({ name: shortName(file.path), path: file.path, source: await response.text() });
  }
  return { root: `${owner}/${repo}@${branch}`, files, skipped: chosen.skipped };
}

/**
 * `owner/repo`, `owner/repo#branch`, or a github.com URL in any of its shapes.
 * @param {string} spec
 */
export function parseRepoSpec(spec) {
  const text = String(spec ?? '').trim();
  if (!text) return null;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^/\s?#]+))?/i.exec(text);
  if (url) {
    return { owner: url[1], repo: url[2].replace(/\.git$/, ''), branch: url[3] ?? null };
  }
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.+))?$/.exec(text);
  if (short) return { owner: short[1], repo: short[2], branch: short[3] ?? null };
  return null;
}

async function json(get, url) {
  const response = await get(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (response.status === 403) {
    throw new Error(
      'GitHub refused the request, which usually means the hourly limit for ' +
        'anonymous requests is used up. Try again later, or load the checkout ' +
        'with:  npm start -- --repo ../your-repo',
    );
  }
  if (response.status === 404) throw new Error('no such repository, or it is private');
  if (!response.ok) throw new Error(`GitHub said ${response.status}`);
  return response.json();
}

/**
 * Files from a `<input type="file">`, a drop, or a directory handle.
 *
 * Takes whatever the browser was willing to give: a `FileList` from a picker
 * with `webkitdirectory`, a `DataTransferItemList` from a drop, or a
 * `FileSystemDirectoryHandle` from `showDirectoryPicker`. The paths differ in
 * each case, which is why they are all normalised here rather than at the three
 * call sites.
 *
 * @param {Iterable<File>} fileList
 * @param {{includeSamples?: boolean}} [opts]
 */
export async function loadDroppedFiles(fileList, opts = {}) {
  const all = [...fileList].map((file) => ({
    file,
    path: file.webkitRelativePath || file.name,
    size: file.size,
  }));
  // A single dropped file is taken whatever it is called, because somebody
  // dropping one file means that file.
  const javaOnly = all.filter((f) => /\.java$/i.test(f.path));
  const candidates = javaOnly.length === 1 ? javaOnly : chooseRepoFiles(javaOnly, opts).files;
  const skipped = javaOnly.length === 1 ? [] : chooseRepoFiles(javaOnly, opts).skipped;
  if (candidates.length === 0) throw new Error('none of those are .java files');

  const files = [];
  for (const candidate of candidates) {
    const source = await (candidate.file ?? javaOnly.find((f) => f.path === candidate.path).file).text();
    files.push({ name: shortName(candidate.path), path: candidate.path, source });
  }
  return { root: rootOf(files.map((f) => f.path)), files, skipped };
}

/**
 * Walk a `FileSystemDirectoryHandle` from `showDirectoryPicker()`.
 *
 * Chromium only, which is why it is one of three ways in rather than the only
 * one. Pruned as it walks: descending into `build` and `.git` on a real
 * repository is thousands of entries for nothing.
 *
 * @param {any} handle
 * @param {{includeSamples?: boolean}} [opts]
 */
export async function loadDirectoryHandle(handle, opts = {}) {
  const found = [];
  await walkDirectory(handle, '', found, opts);
  const chosen = chooseRepoFiles(found, opts);
  if (chosen.files.length === 0) throw new Error('no team Java files in that folder');
  const files = [];
  for (const entry of chosen.files) {
    const file = await entry.handle.getFile();
    files.push({ name: shortName(entry.path), path: entry.path, source: await file.text() });
  }
  return { root: handle.name, files, skipped: chosen.skipped };
}

async function walkDirectory(directory, prefix, out, opts, depthLeft = 12) {
  if (depthLeft <= 0) return;
  for await (const [name, entry] of directory.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      if (HARD_SKIP.some((pattern) => pattern.test(`${path}/`))) continue;
      if (SKIP.some((pattern) => pattern.test(`${path}/`)) && !SAMPLES.test(`${path}/`)) continue;
      if (!opts.includeSamples && SAMPLES.test(`${path}/`)) continue;
      await walkDirectory(entry, path, out, opts, depthLeft - 1);
      continue;
    }
    if (!isTeamJavaFile(path, opts)) continue;
    out.push({ path, handle: entry, size: 0 });
  }
}

/** The longest shared directory prefix, for the "loaded from" line. */
export function rootOf(paths) {
  if (paths.length === 0) return '';
  const parts = paths.map((p) => p.split('/').slice(0, -1));
  const first = parts[0];
  let shared = first.length;
  for (const other of parts.slice(1)) {
    let i = 0;
    while (i < shared && i < other.length && other[i] === first[i]) i++;
    shared = i;
  }
  return first.slice(0, shared).join('/') || '.';
}
