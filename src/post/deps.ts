import type { PostConfig } from "../store/post-store.js";

/** The slice of the post store the steps read. */
export interface PostStore {
  get(jobId: number): PostConfig;
}
