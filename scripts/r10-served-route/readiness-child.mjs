import { spawn } from 'node:child_process';

export function runReadinessChild(program, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Readiness child failed (${code ?? signal})`));
    });
  });
}
