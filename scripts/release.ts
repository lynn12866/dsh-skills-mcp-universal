import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const npmRegistry = 'https://registry.npmjs.org/';
type Command = 'pnpm' | 'npm';
type Runner = (command: Command, args: string[], cwd: string) => Promise<void>;

export class ReleaseError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const runCommand: Runner = (command, args, cwd) =>
  new Promise((done, reject) => {
    // Reuse the pnpm that started this script; do not invoke a different global shim.
    const pnpmEntry = command === 'pnpm' ? process.env.npm_execpath : undefined;
    const child = spawn(
      pnpmEntry ? process.execPath : command,
      pnpmEntry ? [pnpmEntry, ...args] : args,
      {
        cwd,
        stdio: 'inherit',
        shell: false,
      },
    );
    child.once('error', (error) =>
      reject(new ReleaseError(`无法运行 ${command}：${error.message}`)),
    );
    child.once('close', (code, signal) => {
      if (code === 0) done();
      else
        reject(
          new ReleaseError(
            `${command} ${args[0]} 未完成，发布流程已停止。`,
            signal === 'SIGINT' ? 130 : code || 1,
          ),
        );
    });
  });

export async function waitForPublicRelease(
  name: string,
  version: string,
  integrity: string,
  {
    request = fetch,
    sleep = pause,
    attempts = 60,
    intervalMs = 15_000,
  }: {
    request?: typeof fetch;
    sleep?: (ms: number) => Promise<unknown>;
    attempts?: number;
    intervalMs?: number;
  } = {},
) {
  const url = `${npmRegistry}${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await request(url, {
        signal: AbortSignal.timeout(15_000),
        cache: 'no-store',
      });
      if (response.ok) {
        const metadata = await response.json();
        if (
          metadata.name !== name ||
          metadata.version !== version ||
          metadata.dist?.integrity !== integrity
        )
          throw new ReleaseError(
            'npm 版本或完整性与已预览的安装包不同，请核对，勿重复发布同一版本。',
          );
        const tarball = new URL(metadata.dist.tarball);
        if (tarball.origin !== new URL(npmRegistry).origin)
          throw new ReleaseError('npm 返回了非官方安装包地址，校验已停止。');
        const archive = await request(tarball, {
          signal: AbortSignal.timeout(15_000),
          cache: 'no-store',
        });
        if (archive.ok) {
          const actual =
            'sha512-' +
            createHash('sha512')
              .update(Buffer.from(await archive.arrayBuffer()))
              .digest('base64');
          if (actual !== integrity)
            throw new ReleaseError('npm 安装包完整性不符，请核对，勿重复发布同一版本。');
          return;
        }
        if (![404, 429].includes(archive.status) && archive.status < 500)
          throw new ReleaseError(
            `npm 安装包暂不可下载（HTTP ${archive.status}），勿重复发布同一版本。`,
          );
      } else if (![404, 429].includes(response.status) && response.status < 500) {
        throw new ReleaseError(
          `npm 可用性检查失败（HTTP ${response.status}），上传可能已被接受，请勿重复发布。`,
        );
      }
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      // Temporary network errors and publish-time scanning must not cause a second upload.
    }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new ReleaseError(
    '上传已提交，但 npm 尚未公开可安装的版本。请检查扫描或待发布状态，勿重复发布同一版本。',
  );
}

export async function release(
  args: string[],
  {
    cwd = process.cwd(),
    interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
    run = runCommand,
    wait = waitForPublicRelease,
    log = console.log,
  }: {
    cwd?: string;
    interactive?: boolean;
    run?: Runner;
    wait?: typeof waitForPublicRelease;
    log?: (message: string) => void;
  } = {},
) {
  const options = args[0] === '--' ? args.slice(1) : args;
  if (options.length === 1 && ['--help', '-h'].includes(options[0]!)) {
    log(
      'pnpm release：检查、打包、npm 浏览器登录，随后公开发布。\npnpm release:dry-run：仅检查和预览，不登录、不上传。',
    );
    return;
  }
  if (options.some((arg) => arg !== '--dry-run') || options.length > 1)
    throw new ReleaseError('仅支持 --dry-run 或 --help；发布目标固定为 npm 官方仓库。');
  const dryRun = options.includes('--dry-run');
  if (!dryRun && !interactive)
    throw new ReleaseError('请在交互式终端执行 pnpm release，以完成 npm 登录及可能的发布验证。');

  const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  if (
    manifest.private === true ||
    typeof manifest.name !== 'string' ||
    !manifest.name ||
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(manifest.version)
  )
    throw new ReleaseError('package.json 必须有可发布的包名、版本号，且不能标记为 private。');
  if (manifest.publishConfig?.registry && manifest.publishConfig.registry !== npmRegistry)
    throw new ReleaseError('publishConfig.registry 必须是 npm 官方仓库。');

  log(`准备 ${manifest.name}@${manifest.version} → ${npmRegistry}`);
  const stage = await mkdtemp(join(tmpdir(), 'dsh-npm-release-'));
  try {
    // prepack runs the full check (including build); publish this exact archive afterwards.
    await run('pnpm', ['pack', '--pack-destination', stage], cwd);
    const archives = (await readdir(stage)).filter((file) => file.endsWith('.tgz'));
    if (archives.length !== 1) throw new ReleaseError('打包结果无效，发布已停止。');
    const archive = join(stage, archives[0]!);
    const integrity =
      'sha512-' +
      createHash('sha512')
        .update(await readFile(archive))
        .digest('base64');
    const publishArgs = [
      'publish',
      archive,
      '--registry',
      npmRegistry,
      '--access',
      'public',
      '--no-git-checks',
    ];
    await run('pnpm', [...publishArgs, '--dry-run'], cwd);
    if (dryRun) {
      log('试运行完成：未登录 npm，也未上传包。');
      return;
    }
    log('请按 npm 提示在浏览器完成登录；登录成功后将自动发布上方预览的包。');
    await run('npm', ['login', '--auth-type=web', '--registry', npmRegistry], cwd);
    await run('npm', ['whoami', '--registry', npmRegistry], cwd);
    await run('pnpm', publishArgs, cwd);
    log('上传已提交，正在等待 npm 扫描后的公开可安装状态，可能需要数分钟…');
    await wait(manifest.name, manifest.version, integrity);
    log(`发布成功并校验可安装：${manifest.name}@${manifest.version}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await release(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof ReleaseError ? error.exitCode : 1;
  }
}
