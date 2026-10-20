import { mkdir, readFile, rename, rm, open, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

export async function atomicWrite(file: string, content: string, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, 'wx', mode);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
    await chmod(file, mode);
  } finally {
    await rm(tmp, { force: true });
  }
}

// Web and Desktop may update the same workspace at the same time.
export async function fileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + 10000;
  let acquired = false;
  while (!acquired) {
    try {
      await mkdir(lock);
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 60000)
        throw new Error(
          `Stale operation lock: ${lock}. Check that the other Harness process has stopped.`,
        );
      if (Date.now() > deadline)
        throw new Error('Another Harness process is updating this file. Try again.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export class JsonStore<T> {
  private queue = serial();
  constructor(
    public file: string,
    private fallback: T,
  ) {}
  read() {
    return readJson(this.file, this.fallback);
  }
  update<R>(fn: (data: T) => R | Promise<R>): Promise<R> {
    return this.queue(() =>
      fileLock(this.file, async () => {
        const data = await this.read();
        const result = await fn(data);
        await atomicWrite(this.file, JSON.stringify(data, null, 2) + '\n');
        return result;
      }),
    );
  }
}
