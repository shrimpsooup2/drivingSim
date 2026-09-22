import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  REPO_LIMITS,
  chooseRepoFiles,
  isTeamJavaFile,
  loadGitHubRepo,
  loadLocalRepo,
  parseRepoSpec,
  rootOf,
} from '../src/net/repo.js';

// ------------------------------------------------------------- what to take

test('a repository spec is read in every shape anybody writes it', () => {
  assert.deepEqual(parseRepoSpec('shrimpsooup2/drivingSim'), {
    owner: 'shrimpsooup2',
    repo: 'drivingSim',
    branch: null,
  });
  assert.deepEqual(parseRepoSpec('owner/repo#dev'), { owner: 'owner', repo: 'repo', branch: 'dev' });
  assert.deepEqual(parseRepoSpec('https://github.com/a/b'), { owner: 'a', repo: 'b', branch: null });
  assert.deepEqual(parseRepoSpec('github.com/a/b.git'), { owner: 'a', repo: 'b', branch: null });
  assert.deepEqual(parseRepoSpec('https://github.com/a/b/tree/comp'), {
    owner: 'a',
    repo: 'b',
    branch: 'comp',
  });
  assert.equal(parseRepoSpec('not a repo'), null);
  assert.equal(parseRepoSpec(''), null);
});

test('a team’s own Java is taken and the rest is left', () => {
  const team = 'TeamCode/src/main/java/org/firstinspires/ftc/teamcode/Auto.java';
  assert.equal(isTeamJavaFile(team), true);
  assert.equal(isTeamJavaFile('TeamCode/build/generated/Thing.java'), false);
  assert.equal(isTeamJavaFile('.git/objects/x.java'), false);
  assert.equal(isTeamJavaFile('FtcRobotController/src/main/java/com/qualcomm/App.java'), false);
  assert.equal(isTeamJavaFile('TeamCode/src/test/java/AutoTest.java'), false);
  assert.equal(isTeamJavaFile('build.gradle'), false);
  // The SDK's 40 examples would bury a team's four, so they are opt-in.
  const sample = 'FtcRobotController/src/main/java/external/samples/BasicOpMode.java';
  assert.equal(isTeamJavaFile(sample), false);
  assert.equal(isTeamJavaFile(sample, { includeSamples: true }), true);
});

test('the shallowest files win when there are too many', () => {
  const files = [
    { path: 'TeamCode/src/A.java', size: 100 },
    { path: 'TeamCode/src/deep/deeper/B.java', size: 100 },
    { path: 'TeamCode/src/C.java', size: 100 },
  ];
  const chosen = chooseRepoFiles(files);
  assert.deepEqual(chosen.files.map((f) => f.path), [
    'TeamCode/src/A.java',
    'TeamCode/src/C.java',
    'TeamCode/src/deep/deeper/B.java',
  ]);

  // And the limits hold, reporting what was left behind.
  const many = Array.from({ length: REPO_LIMITS.maxFiles + 5 }, (_, i) => ({
    path: `TeamCode/F${i}.java`,
    size: 10,
  }));
  const capped = chooseRepoFiles(many);
  assert.equal(capped.files.length, REPO_LIMITS.maxFiles);
  assert.equal(capped.skipped.length, 5);

  // A single enormous file is skipped rather than blowing the byte budget.
  const huge = chooseRepoFiles([{ path: 'TeamCode/Huge.java', size: REPO_LIMITS.maxFileBytes + 1 }]);
  assert.equal(huge.files.length, 0);
});

test('the shared root is what the readout shows', () => {
  assert.equal(rootOf(['a/b/c/X.java', 'a/b/d/Y.java']), 'a/b');
  assert.equal(rootOf(['X.java']), '.');
  assert.equal(rootOf([]), '');
});

// ------------------------------------------------------------- over the wire

test('a GitHub repository is read with two kinds of request', async () => {
  const asked = [];
  const fakeFetch = async (url) => {
    asked.push(String(url));
    if (String(url).endsWith('/repos/team/code')) {
      return json({ default_branch: 'comp' });
    }
    if (String(url).includes('/git/trees/comp')) {
      return json({
        truncated: false,
        tree: [
          { type: 'blob', path: 'TeamCode/src/Auto.java', size: 40 },
          { type: 'blob', path: 'TeamCode/src/Helper.java', size: 40 },
          { type: 'blob', path: 'TeamCode/build/Nope.java', size: 40 },
          { type: 'blob', path: 'README.md', size: 40 },
          { type: 'tree', path: 'TeamCode' },
        ],
      });
    }
    return text(`// ${String(url).split('/').pop()}`);
  };

  const loaded = await loadGitHubRepo('team/code', { fetch: fakeFetch });
  assert.equal(loaded.root, 'team/code@comp');
  assert.deepEqual(loaded.files.map((f) => f.name), ['Auto.java', 'Helper.java']);
  assert.match(loaded.files[0].source, /Auto\.java/);
  // The default branch was looked up, then one tree, then one raw file each.
  assert.equal(asked.filter((u) => u.includes('raw.githubusercontent.com')).length, 2);
  assert.ok(asked.some((u) => u.includes('/git/trees/comp?recursive=1')));
});

test('a branch given in the spec skips the lookup', async () => {
  const asked = [];
  const fakeFetch = async (url) => {
    asked.push(String(url));
    if (String(url).includes('/git/trees/')) {
      return json({ tree: [{ type: 'blob', path: 'TeamCode/A.java', size: 10 }] });
    }
    return text('// A');
  };
  await loadGitHubRepo('team/code#wip', { fetch: fakeFetch });
  assert.ok(!asked.some((u) => /\/repos\/team\/code$/.test(u)), 'no default-branch request');
  assert.ok(asked.some((u) => u.includes('/git/trees/wip')));
});

test('GitHub’s refusals are explained rather than passed through', async () => {
  const rateLimited = async () => new Response('', { status: 403 });
  await assert.rejects(() => loadGitHubRepo('a/b', { fetch: rateLimited }), /limit for anonymous/);

  const missing = async () => new Response('', { status: 404 });
  await assert.rejects(() => loadGitHubRepo('a/b', { fetch: missing }), /no such repository/);

  const empty = async (url) =>
    String(url).includes('/git/trees/')
      ? json({ tree: [{ type: 'blob', path: 'README.md', size: 4 }] })
      : json({ default_branch: 'main' });
  await assert.rejects(() => loadGitHubRepo('a/b', { fetch: empty }), /no team Java files/);
});

test('with no repository attached, the message says how to attach one', async () => {
  const notFound = async () => new Response('', { status: 404 });
  await assert.rejects(() => loadLocalRepo({ fetch: notFound }), /--repo/);
});

// ------------------------------------------------------- the server endpoint

test('the dev server serves a checkout’s op-modes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ftcsim-repo-'));
  const team = join(dir, 'TeamCode', 'src', 'main', 'java', 'org', 'firstinspires', 'ftc', 'teamcode');
  await mkdir(team, { recursive: true });
  await mkdir(join(dir, 'TeamCode', 'build'), { recursive: true });
  await mkdir(join(dir, 'FtcRobotController', 'src', 'main', 'java', 'external', 'samples'), {
    recursive: true,
  });
  await writeFile(join(team, 'Auto.java'), '@Autonomous public class Auto extends LinearOpMode { public void runOpMode() {} }');
  await writeFile(join(team, 'Util.java'), 'public class Util {}');
  await writeFile(join(dir, 'TeamCode', 'build', 'Generated.java'), 'class Generated {}');
  await writeFile(
    join(dir, 'FtcRobotController', 'src', 'main', 'java', 'external', 'samples', 'Sample.java'),
    'class Sample {}',
  );

  const port = 8400 + Math.floor(Math.random() * 300);
  const server = spawn(
    process.execPath,
    ['tools/serve.js', '--port', String(port), '--no-open', '--repo', dir],
    { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' },
  );
  try {
    const body = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/repo/files`);
      if (!response.ok) return null;
      return response.json();
    });
    assert.equal(body.root, dir);
    assert.deepEqual(
      body.files.map((f) => f.name).sort(),
      ['Auto.java', 'Util.java'],
      'the team’s files, not the build output and not the SDK samples',
    );
    assert.match(body.files.find((f) => f.name === 'Auto.java').source, /LinearOpMode/);
    // And the paths are relative to the checkout, which is what the panel shows.
    assert.ok(body.files.every((f) => !f.path.startsWith('/')));
  } finally {
    server.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function text(value) {
  return new Response(value, { status: 200 });
}

/** Poll until the server is up, or give up. */
async function waitFor(attempt, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const result = await attempt();
      if (result) return result;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the server never answered');
}
