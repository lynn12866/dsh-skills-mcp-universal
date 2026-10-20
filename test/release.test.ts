import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { npmRegistry, release, ReleaseError, waitForPublicRelease } from '../scripts/release.js';

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-release-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'fixture-package', version: '1.0.0' }),
  );
  const calls: { command: string; args: string[] }[] = [];
  const log: string[] = [];
  let archive = '';
  const run = async (command: 'npm' | 'pnpm', args: string[]) => {
    calls.push({ command, args });
    if (args[0] === 'pack') {
      archive = join(args[2]!, 'fixture-package-1.0.0.tgz');
      await writeFile(archive, 'owned test archive');
    }
  };
  return {
    cwd,
    calls,
    log,
    run,
    get archive() {
      return archive;
    },
    options: {
      cwd,
      interactive: true,
      run,
      wait: async () => {},
      log: (message: string) => log.push(message),
    },
  };
}

test('release builds and previews before login, then verifies identity and publishes exactly the previewed archive', async (t) => {
  const f = await fixture(t);
  await release([], f.options);
  assert.deepEqual(
    f.calls.map((c) => [c.command, c.args[0]]),
    [
      ['pnpm', 'pack'],
      ['pnpm', 'publish'],
      ['npm', 'login'],
      ['npm', 'whoami'],
      ['pnpm', 'publish'],
    ],
  );
  const preview = f.calls[1]!.args,
    published = f.calls[4]!.args;
  assert.deepEqual(preview, [...published, '--dry-run']);
  assert.equal(published[1], f.archive);
  assert.equal(published[published.indexOf('--registry') + 1], npmRegistry);
  assert.deepEqual(f.calls[2]!.args, ['login', '--auth-type=web', '--registry', npmRegistry]);
  assert(f.log.some((message) => message.includes('发布成功')));
  await assert.rejects(access(f.archive));
});

test('dry-run never logs in or uploads and works without an interactive terminal', async (t) => {
  const f = await fixture(t);
  await release(['--', '--dry-run'], { ...f.options, interactive: false });
  assert.equal(f.calls.length, 2);
  assert(f.calls[1]!.args.includes('--dry-run'));
  assert(f.log.some((message) => message.includes('未上传')));
  await assert.rejects(access(f.archive));
});

for (const failingStep of [0, 1, 2, 3, 4]) {
  test(`failure or cancellation at step ${failingStep + 1} stops the pipeline and cleans its archive`, async (t) => {
    const f = await fixture(t);
    let steps = 0;
    await assert.rejects(
      release([], {
        ...f.options,
        run: async (command, args, cwd) => {
          if (steps++ === failingStep) throw new ReleaseError('cancelled', 130);
          await f.run(command, args);
        },
      }),
      (error) => error instanceof ReleaseError && error.exitCode === 130,
    );
    assert.equal(steps, failingStep + 1);
    assert(!f.log.some((message) => message.includes('发布成功')));
    if (f.archive) await assert.rejects(access(f.archive));
  });
}

test('noninteractive publish, unknown flags, private packages and redirected registries fail before any command runs', async (t) => {
  const f = await fixture(t);
  await assert.rejects(release([], { ...f.options, interactive: false }), /交互式终端/);
  await assert.rejects(release(['--registry=other'], f.options), /仅支持/);
  await writeFile(
    join(f.cwd, 'package.json'),
    JSON.stringify({ name: 'fixture-package', version: '1.0.0', private: true }),
  );
  await assert.rejects(release([], f.options), /private/);
  await writeFile(
    join(f.cwd, 'package.json'),
    JSON.stringify({
      name: 'fixture-package',
      version: '1.0.0',
      publishConfig: { registry: 'https://other.invalid/' },
    }),
  );
  await assert.rejects(release([], f.options), /官方仓库/);
  assert.deepEqual(f.calls, []);
});

const archiveBytes = 'exact npm archive';
const archiveIntegrity = 'sha512-' + createHash('sha512').update(archiveBytes).digest('base64');
const publicMetadata = {
  name: 'fixture-package',
  version: '1.0.0',
  dist: {
    integrity: archiveIntegrity,
    tarball: npmRegistry + 'fixture-package/-/fixture-package-1.0.0.tgz',
  },
};

test('availability waits for metadata and tarball to become public and verifies the exact archive', async () => {
  const responses = [
    new Response(null, { status: 404 }),
    Response.json(publicMetadata),
    new Response(null, { status: 404 }),
    Response.json(publicMetadata),
    new Response(archiveBytes),
  ];
  let sleeps = 0;
  await waitForPublicRelease('fixture-package', '1.0.0', archiveIntegrity, {
    request: async () => responses.shift()!,
    sleep: async () => {
      sleeps++;
    },
    attempts: 3,
  });
  assert.equal(sleeps, 2);
  assert.equal(responses.length, 0);
});

test('pending registry version never reports success or triggers another upload', async () => {
  let requests = 0;
  await assert.rejects(
    waitForPublicRelease('fixture-package', '1.0.0', archiveIntegrity, {
      request: async () => {
        requests++;
        return new Response(null, { status: 404 });
      },
      sleep: async () => {},
      attempts: 2,
    }),
    /勿重复发布/,
  );
  assert.equal(requests, 2);
});

test('wrong metadata, redirected tarball or changed archive is rejected', async () => {
  for (const metadata of [
    { ...publicMetadata, version: 'other' },
    {
      ...publicMetadata,
      dist: { ...publicMetadata.dist, tarball: 'https://other.invalid/archive.tgz' },
    },
    publicMetadata,
  ]) {
    let calls = 0;
    await assert.rejects(
      waitForPublicRelease('fixture-package', '1.0.0', archiveIntegrity, {
        request: async () =>
          calls++ === 0 ? Response.json(metadata) : new Response('wrong archive'),
        attempts: 1,
      }),
      /不同|非官方|不符/,
    );
  }
});

test('registry availability failure does not print a successful release', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    release([], {
      ...f.options,
      wait: async () => {
        throw new ReleaseError('registry pending');
      },
    }),
    /registry pending/,
  );
  assert.equal(f.calls.length, 5);
  assert(!f.log.some((message) => message.includes('发布成功')));
  await assert.rejects(access(f.archive));
});
