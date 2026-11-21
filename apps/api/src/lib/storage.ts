import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Package storage. Local filesystem for the MVP; swap for S3/R2 behind the same interface later. */
export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

export function fsStorage(root: string): Storage {
  const base = resolve(root);
  const path = (key: string) => {
    const p = resolve(join(base, key));
    if (!p.startsWith(base + "/")) throw new Error("invalid storage key");
    return p;
  };
  return {
    async put(key, data) {
      await mkdir(dirname(path(key)), { recursive: true });
      await writeFile(path(key), data);
    },
    get: (key) => readFile(path(key)),
  };
}

export function memoryStorage(): Storage {
  const m = new Map<string, Buffer>();
  return {
    async put(k, d) { m.set(k, d); },
    async get(k) {
      const v = m.get(k);
      if (!v) throw new Error("not found");
      return v;
    },
  };
}
