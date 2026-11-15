import os from "node:os";
import { Worker } from "node:worker_threads";

export async function runFormatPool(tasks, options = {}) {
  const concurrency = Math.max(
    1,
    Math.min(
      options.concurrency || Math.min(8, os.availableParallelism?.() || os.cpus().length),
      tasks.length || 1,
    ),
  );
  if (tasks.length === 0) return [];

  const workerUrl = new URL("./format-worker.js", import.meta.url);
  const workers = [];
  const results = [];
  let next = 0;
  let completed = 0;
  let failed = false;

  return await new Promise((resolve, reject) => {
    const finish = () => {
      for (const worker of workers) worker.terminate();
      resolve(results);
    };

    const assign = (worker) => {
      if (next >= tasks.length) {
        if (completed === tasks.length && !failed) finish();
        return;
      }
      const task = tasks[next++];
      worker.postMessage(task);
    };

    const onMessage = (worker, msg) => {
      completed++;
      results.push({ ...msg, code: undefined });
      if (typeof options.onResult === "function") options.onResult(msg);
      if (options.progress && completed % options.progress === 0) {
        console.error(`[format] ${completed}/${tasks.length}`);
      }
      assign(worker);
    };

    for (let i = 0; i < concurrency; i++) {
      const worker = new Worker(workerUrl);
      workers.push(worker);
      worker.on("message", (msg) => onMessage(worker, msg));
      worker.on("error", (error) => {
        failed = true;
        for (const w of workers) w.terminate();
        reject(error);
      });
      worker.on("exit", (code) => {
        if (code !== 0 && !failed) {
          failed = true;
          reject(new Error(`format worker exited with code ${code}`));
        }
      });
      assign(worker);
    }
  });
}
