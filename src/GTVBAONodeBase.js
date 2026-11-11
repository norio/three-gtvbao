import { Node, REVISION, TempNode } from 'three/webgpu';

// three r187 folded TempNode's temporary-variable caching into Node and
// deprecated TempNode, which now warns on every construction. Extend Node
// there; r184-r186 keep TempNode, which still provides that caching.
export const GTVBAONodeBase = /*@__PURE__*/ ( () => Number.parseInt( REVISION, 10 ) >= 187 ? Node : TempNode )();
