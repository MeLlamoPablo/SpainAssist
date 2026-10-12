import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * PGlite is single-process: two processes opening the same data directory corrupt it. This
 * takes an exclusive lock file next to the directory (`<dir>.lock`, holding the PID) and returns
 * a release function. Stale locks (dead PID) are taken over.
 */
export function acquireDirLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const lockPath = `${dir}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off('exit', release);
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
      process.on('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      // Our own PID counts as "in use" too: two PGlite instances on one directory corrupt it.
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
        throw new Error(
          `The PGlite database at ${dir} is in use by process ${pid}. Stop that process first ` +
            `(or use the admin API). If no such process is running, delete ${lockPath}.`,
        );
      }
      unlinkSync(lockPath); // stale lock
    }
  }
  throw new Error(`Could not lock ${dir}`);
}
