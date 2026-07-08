// Module worker: runs the heavy matching off the main thread.
import { matchPiece } from './matching.js';

self.onmessage = (e) => {
  const { ref, patches, opts } = e.data;
  const results = [];
  for (let i = 0; i < patches.length; i++) {
    const candidates = matchPiece(ref, patches[i], {
      ...opts,
      onProgress: (f) => {
        self.postMessage({ type: 'progress', done: i + f, total: patches.length });
      },
    });
    results.push(candidates);
    self.postMessage({ type: 'progress', done: i + 1, total: patches.length });
  }
  self.postMessage({ type: 'result', results });
};
