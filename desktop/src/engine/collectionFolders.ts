import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '@core/config.js';

/** Prefer the watched source folder; generated/manual collections live in wikiRoot. */
export function collectionFolders(
  config: Pick<Config, 'wikiRoot' | 'watchDirs' | 'digestCollection'>,
  collection: string,
): string[] {
  const folders = new Set<string>();
  const addDirectory = (dir: string) => {
    try {
      if (fs.statSync(dir).isDirectory()) folders.add(path.resolve(dir));
    } catch {
      /* missing */
    }
  };
  if (collection !== config.digestCollection) {
    for (const watch of config.watchDirs) {
      if (watch.collection) {
        if (watch.collection === collection) addDirectory(watch.path);
        continue;
      }
      if (!watch.collectionFromSubdir) continue;
      if (watch.fallbackCollection === collection) addDirectory(watch.path);
      try {
        for (const dir of fs.readdirSync(watch.path, { withFileTypes: true })) {
          if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
          if ((watch.subdirAlias[dir.name] ?? dir.name) === collection) {
            addDirectory(path.join(watch.path, dir.name));
          }
        }
      } catch {
        /* watch root may be disconnected */
      }
    }
  }
  if (folders.size === 0) {
    const root = path.resolve(config.wikiRoot);
    const dir = path.resolve(root, collection);
    const relative = path.relative(root, dir);
    if (
      relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    ) {
      addDirectory(dir);
    }
  }
  return [...folders];
}
