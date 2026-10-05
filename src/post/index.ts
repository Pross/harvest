import type { Logger } from "../logger.js";
import { createChmodStep } from "./chmod.js";
import type { PostStore } from "./deps.js";
import { createExtractStep } from "./extract.js";
import { findTools } from "./extract-tools.js";
import type { AfterPromoteInput, AfterPromoteStep, ExtractInput, ExtractStep, PostPipeline, PostResult, RunNotifier } from "./types.js";

export type PostPipelineDeps = {
  postStore: PostStore;
  extract: ExtractStep;
  chmod: AfterPromoteStep;
  arr?: AfterPromoteStep;
  notifier?: RunNotifier;
  logger: Logger;
};

/** The one place post-action errors are caught: a failing step is logged and becomes a warning, never an exception. */
async function guard<T extends PostResult>(logger: Logger, name: string, fallback: Omit<T, "warnings">, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, step: name }, "post-action step failed");
    return { ...fallback, warnings: [`${name} failed: ${msg}`] } as T;
  }
}

/** Order inside a unit: extract (staging) -> promote -> afterPromote [chmod, arr]. Per run: afterRun. Jobs without post config are no-ops. */
export function createPostPipeline(deps: PostPipelineDeps): PostPipeline {
  const { logger } = deps;
  return {
    extractInStaging(input: ExtractInput) {
      const empty = { added: [], removed: [] };
      if (deps.postStore.get(input.job.id).extract === "off") return Promise.resolve({ warnings: [], ...empty });
      return guard(logger, "extraction", empty, () => deps.extract.run(input));
    },
    async afterPromote(input: AfterPromoteInput) {
      const warnings: string[] = [];
      const steps: [string, AfterPromoteStep | undefined][] = [["chmod", deps.chmod], ["*arr notification", deps.arr]];
      for (const [name, step] of steps) {
        if (step) warnings.push(...(await guard(logger, name, {}, () => step.run(input))).warnings);
      }
      return { warnings };
    },
    afterRun(input) {
      const { notifier } = deps;
      return notifier ? guard(logger, "notifications", {}, () => notifier.run(input)) : Promise.resolve({ warnings: [] });
    },
  };
}

/** The production pipeline: real extractors found on PATH, chmod, and optional *arr / notifier steps supplied by the wiring code. */
export function createDefaultPostPipeline(i: { postStore: PostStore; logger: Logger; arr?: AfterPromoteStep; notifier?: RunNotifier }): PostPipeline {
  const tools = findTools();
  i.logger.info({ sevenZip: tools.sevenZip?.bin ?? null, rar: tools.rar?.name ?? null }, "archive extractors available");
  const base = { postStore: i.postStore, logger: i.logger };
  return createPostPipeline({ ...base, extract: createExtractStep({ postStore: i.postStore, tools }), chmod: createChmodStep(base), ...(i.arr ? { arr: i.arr } : {}), ...(i.notifier ? { notifier: i.notifier } : {}) });
}
