import type { JsonPatchOp } from "./hpp.ts";

function decode(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Applies add/replace/remove operations (RFC 6902 subset) to a deep clone.
 * Throws on paths that do not exist so a buggy hook cannot silently corrupt data.
 */
export function applyPatch<T>(doc: T, ops: JsonPatchOp[]): T {
  const root = structuredClone(doc) as unknown;
  let out = root;
  for (const op of ops) {
    if (!op || typeof op.path !== "string") throw new Error("invalid patch operation");
    if (op.path === "") {
      if (op.op === "remove") throw new Error("cannot remove the document root");
      out = structuredClone((op as { value: unknown }).value);
      continue;
    }
    if (!op.path.startsWith("/")) throw new Error(`invalid JSON pointer: ${op.path}`);
    const segs = op.path.slice(1).split("/").map(decode);
    if (segs.some((s) => FORBIDDEN.has(s))) throw new Error(`forbidden path segment in ${op.path}`);
    const last = segs.pop() as string;
    let parent = out as Record<string, unknown> | unknown[];
    for (const s of segs) {
      const next = Array.isArray(parent) ? parent[Number(s)] : (parent as Record<string, unknown>)[s];
      if (next === undefined || next === null || typeof next !== "object") throw new Error(`path not found: ${op.path}`);
      parent = next as Record<string, unknown> | unknown[];
    }
    if (Array.isArray(parent)) {
      const idx = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) throw new Error(`invalid array index: ${op.path}`);
      if (op.op === "add") parent.splice(idx, 0, structuredClone(op.value));
      else if (op.op === "replace") {
        if (idx >= parent.length) throw new Error(`path not found: ${op.path}`);
        parent[idx] = structuredClone(op.value);
      } else parent.splice(idx, 1);
    } else {
      if ((op.op === "replace" || op.op === "remove") && !Object.hasOwn(parent, last)) throw new Error(`path not found: ${op.path}`);
      if (op.op === "remove") delete parent[last];
      else parent[last] = structuredClone(op.value);
    }
  }
  return out as T;
}
