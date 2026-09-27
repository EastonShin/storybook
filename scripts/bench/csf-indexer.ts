import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { globby } from 'globby';
import {
  type OxcCsfFallbackReason,
  type OxcCsfIndexerDiagnostics,
  indexCsfWithOxc,
  loadCsf,
} from 'storybook/internal/csf-tools';

const STORY_GLOB = 'code/**/*.{story,stories}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}';
const IGNORE = ['**/node_modules/**', '**/dist/**', 'code/sandbox/**'];
const REPEAT = Number.parseInt(process.env.CSF_INDEXER_BENCH_REPEAT || '5', 10);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Source = {
  fileName: string;
  code: string;
};

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

const makeTitle = (fileName: string) => (userTitle?: string) => userTitle || fileName;

const babelIndex = ({ fileName, code }: Source): Outcome => {
  try {
    return {
      ok: true,
      value: loadCsf(code, { makeTitle: makeTitle(fileName), fileName }).parse().indexInputs,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const hybridIndex = ({ fileName, code }: Source) => {
  const diagnostics: OxcCsfIndexerDiagnostics = {};

  try {
    const fast = indexCsfWithOxc(
      code,
      fileName,
      { makeTitle: makeTitle(fileName) },
      diagnostics
    );
    if (fast) {
      return {
        fastPath: true,
        outcome: { ok: true, value: fast } satisfies Outcome,
      };
    }

    return {
      fastPath: false,
      fallbackReason: diagnostics.fallbackReason,
      outcome: babelIndex({ fileName, code }),
    };
  } catch (error) {
    return {
      fastPath: false,
      fallbackReason: diagnostics.fallbackReason,
      outcome: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies Outcome,
    };
  }
};

const duration = (run: () => void) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

const percentile = (values: number[], ratio: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
};

const format = (value: number) => `${value.toFixed(2)} ms`;

const files = await globby(STORY_GLOB, {
  cwd: REPO_ROOT,
  ignore: IGNORE,
  absolute: true,
});
const sources = await Promise.all(
  files.map(async (fileName) => ({
    fileName,
    code: await readFile(fileName, 'utf8'),
  }))
);

const baseline = new Map<string, Outcome>();
const hybrid = new Map<string, ReturnType<typeof hybridIndex>>();
let fastPathHits = 0;
const fallbackReasons = new Map<OxcCsfFallbackReason | 'unknown', number>();

for (const source of sources) {
  const baselineResult = babelIndex(source);
  const hybridResult = hybridIndex(source);

  baseline.set(source.fileName, baselineResult);
  hybrid.set(source.fileName, hybridResult);
  fastPathHits += hybridResult.fastPath ? 1 : 0;
  if (!hybridResult.fastPath) {
    const reason = hybridResult.fallbackReason ?? 'unknown';
    fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1);
  }
}

const mismatches = sources.filter(({ fileName }) => {
  const left = baseline.get(fileName);
  const right = hybrid.get(fileName)?.outcome;
  return !left || !right || !isDeepStrictEqual(left, right);
});

for (const source of sources) {
  babelIndex(source);
  hybridIndex(source);
}

const babelTimings: number[] = [];
const hybridTimings: number[] = [];

for (let index = 0; index < REPEAT; index++) {
  babelTimings.push(
    duration(() => {
      for (const source of sources) {
        babelIndex(source);
      }
    })
  );

  hybridTimings.push(
    duration(() => {
      for (const source of sources) {
        hybridIndex(source);
      }
    })
  );
}

const babelAverage = average(babelTimings);
const hybridAverage = average(hybridTimings);
const speedup = hybridAverage === 0 ? 0 : babelAverage / hybridAverage;

console.table({
  files: sources.length,
  fastPathHits,
  fallbacks: sources.length - fastPathHits,
  hitRate: `${((fastPathHits / Math.max(1, sources.length)) * 100).toFixed(1)}%`,
  mismatches: mismatches.length,
  repeat: REPEAT,
});

console.table(
  Object.fromEntries(
    [...fallbackReasons.entries()].sort((a, b) => b[1] - a[1])
  )
);

console.table({
  babelAverage: format(babelAverage),
  babelP95: format(percentile(babelTimings, 0.95)),
  hybridAverage: format(hybridAverage),
  hybridP95: format(percentile(hybridTimings, 0.95)),
  speedup: `${speedup.toFixed(2)}x`,
});

if (mismatches.length > 0) {
  console.error('Parity mismatches:');
  for (const { fileName } of mismatches.slice(0, 20)) {
    console.error(fileName);
    console.error('Babel:', JSON.stringify(baseline.get(fileName), null, 2));
    console.error('Hybrid:', JSON.stringify(hybrid.get(fileName)?.outcome, null, 2));
  }
  process.exitCode = 1;
}
