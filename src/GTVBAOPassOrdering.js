import { context } from 'three/tsl';

/**
 * Makes `dependency` render before `passNode` every frame.
 *
 * three evaluates a pass lazily, from inside whichever material first samples
 * it. A lit scene pass whose materials sample the AO texture therefore renders
 * the AO, and through it the geometry pre-pass, in the middle of its own draw
 * loop. Both passes render the same scene with the same camera, and three keeps
 * one render list per scene and camera, so the nested render resets the list
 * the outer loop is iterating. Pulling the dependency through the node frame
 * first keeps the once-per-frame guard and moves it out of the nesting.
 *
 * The same ordering matters for GTVBAONode itself: its depth prefilter is a
 * compute dispatch, which never triggers the pre-pass it reads, and
 * GTVBAODenoiseNode sizes itself from the AO output, so it must run after it.
 */
export function renderPassAfter( passNode, dependency ) {
	const updateBefore = passNode.updateBefore.bind( passNode );
	passNode.updateBefore = ( frame ) => {
		frame.updateBeforeNode( dependency );
		return updateBefore( frame );
	};
}

/**
 * A context that overrides the hook builtinAOContext defines, so a pass
 * evaluated from inside an AO-lit pass renders plain. Assign it to the
 * geometry pre-pass: a PassNode inherits the renderer's active context, and
 * without this the AO inputs (including the pre-pass's own depth) would be
 * bound while the pre-pass renders its materials.
 */
export function createPassthroughAoContext() {
	return context( {
		getAO: ( inputNode ) => inputNode
	} );
}
