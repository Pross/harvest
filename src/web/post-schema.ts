import { z } from "zod";
import { modeProblem } from "../post/chmod.js";
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
});

export type PostForm = { extract: string; chmod_file: string; chmod_dir: string };

export const formOf = (c: PostConfig): PostForm => ({ extract: c.extract, chmod_file: c.chmodFile ?? "", chmod_dir: c.chmodDir ?? "" });

/** Validates the post-actions form. Errors are keyed by field name for inline display. */
export function parsePostForm(body: unknown): { ok: true; config: PostConfig } | { ok: false; errors: Record<string, string>; values: PostForm } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string).slice(0, 20) : "");
  const parsed = Body.safeParse({ extract: str("extract"), chmod_file: str("chmod_file"), chmod_dir: str("chmod_dir") });
  if (parsed.success) {
    const d = parsed.data;
    return { ok: true, config: { extract: d.extract, chmodFile: d.chmod_file || null, chmodDir: d.chmod_dir || null } };
  }
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) errors[String(issue.path[0])] ??= issue.message;
  return { ok: false, errors, values: { extract: str("extract"), chmod_file: str("chmod_file"), chmod_dir: str("chmod_dir") } };
}
