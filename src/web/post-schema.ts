import { z } from "zod";
import { modeProblem } from "../post/chmod.js";
import { MAX_STRIP_LENGTH } from "../post/title-nfo.js";
import type { PostConfig } from "../store/post-store.js";

const mode = (kind: "file" | "dir") =>
  z.string().trim().superRefine((v, ctx) => {
    const problem = v === "" ? null : modeProblem(kind, v);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const Body = z.object({
  extract: z.enum(["off", "keep", "delete"], { message: "Choose how archives are handled." }),
  chmod_file: mode("file").default(""),
  chmod_dir: mode("dir").default(""),
  title_nfo: z.string().default(""),
  title_strip: z.string().trim().max(MAX_STRIP_LENGTH, `Use at most ${MAX_STRIP_LENGTH} characters.`).refine((v) => !/[\u0000-\u001f]/.test(v), "Remove control characters.").default(""),
});

export type PostForm = { extract: string; chmod_file: string; chmod_dir: string; title_nfo: string; title_strip: string };

export const formOf = (c: PostConfig): PostForm => ({ extract: c.extract, chmod_file: c.chmodFile ?? "", chmod_dir: c.chmodDir ?? "", title_nfo: c.titleNfo ? "on" : "", title_strip: c.titleStrip });

/** Validates the post-actions form. Errors are keyed by field name for inline display. */
export function parsePostForm(body: unknown): { ok: true; config: PostConfig } | { ok: false; errors: Record<string, string>; values: PostForm } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string).slice(0, 20) : "");
  const strip = typeof raw["title_strip"] === "string" ? (raw["title_strip"] as string).slice(0, MAX_STRIP_LENGTH + 1) : "";
  const titleNfo = ["on", "1", "true"].includes(str("title_nfo")) ? "on" : "";
  const parsed = Body.safeParse({ extract: str("extract"), chmod_file: str("chmod_file"), chmod_dir: str("chmod_dir"), title_nfo: titleNfo, title_strip: strip });
  if (parsed.success) {
    const d = parsed.data;
    return { ok: true, config: { extract: d.extract, chmodFile: d.chmod_file || null, chmodDir: d.chmod_dir || null, titleNfo: d.title_nfo === "on", titleStrip: d.title_strip } };
  }
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) errors[String(issue.path[0])] ??= issue.message;
  return { ok: false, errors, values: { extract: str("extract"), chmod_file: str("chmod_file"), chmod_dir: str("chmod_dir"), title_nfo: titleNfo, title_strip: strip } };
}
