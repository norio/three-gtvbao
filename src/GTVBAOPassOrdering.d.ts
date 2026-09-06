import type { Node } from "three/webgpu";
import type { context } from "three/tsl";

export function renderPassAfter(
  passNode: Pick<Node, "updateBefore">,
  dependency: Node
): void;

export function createPassthroughAoContext(): ReturnType<typeof context>;
