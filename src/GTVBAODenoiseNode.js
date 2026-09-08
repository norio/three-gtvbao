import {
	DataTexture,
	NodeMaterial,
	NodeUpdateType,
	QuadMesh,
	RedFormat,
	RepeatWrapping,
	RendererUtils,
	TempNode,
	Vector2
} from 'three/webgpu';
import {
	Fn,
	If,
	PI,
	abs,
	clamp,
	convertToTexture,
	cos,
	dot,
	float,
	floor,
	int,
	ivec2,
	logarithmicDepthToViewZ,
	mat2,
	max,
	min,
	nodeObject,
	passTexture,
	pow,
	property,
	reference,
	sin,
	texture,
	textureSize,
	uniform,
	uv,
	vec2,
	vec3,
	vec4,
	viewZToPerspectiveDepth
} from 'three/tsl';
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js';
import { getDepthNormal } from './GTVBAODepthNormal.js';
import { depthTexelOfAoTexel } from './GTVBAODepthPrefilter.js';
import { GTVBAO_PASS_NAMES } from './GTVBAOPassNames.js';
import { createGtvbaoRenderTarget } from './GTVBAORenderTarget.js';
import { createViewPositionFromLinearDepth, getViewPosition } from './GTVBAOViewSpace.js';
const _quadMesh = /*@__PURE__*/ new QuadMesh();
// The kernel never changes at runtime, so it is baked into the shader as
// literals rather than read back from a uniform array inside the loop.
const DENOISE_SAMPLES = /*@__PURE__*/ generateDenoiseSamples( 16, 2, 1 );
let _rendererState;
class GTVBAODenoiseNode extends TempNode {
	static get type() {
		return 'GTVBAODenoiseNode';
	}
	constructor( textureNode, depthNode, normalNode, camera, options = {} ) {
		super( 'float' );
		this.textureNode = textureNode;
		this.depthNode = depthNode;
		this.normalNode = normalNode;
		this.noiseNode = null;
		this._normalEncoding = options.normalEncoding ?? 'view';
		this.useTemporalDenoiseRotation = options.useTemporalDenoiseRotation ?? false;
		// GTVBAONode whose linear-depth MIP level 0 (AO resolution) replaces the
		// full-resolution depth fetches while its useDepthMips variant is on.
		this.linearDepthSource = options.linearDepthSource ?? null;
		this.lumaPhi = uniform( 4 );
		this.depthPhi = uniform( 4 );
		this.normalPhi = uniform( 16 );
		this.radius = uniform( 2 );
		this.index = uniform( 0 );
		this.updateBeforeType = NodeUpdateType.FRAME;
		this._resolution = uniform( new Vector2() );
		this._isOrthographicCamera = camera.isOrthographicCamera === true;
		this._cameraProjectionMatrixInverse = uniform( camera.projectionMatrixInverse );
		this._cameraNear = reference( 'near', 'float', camera );
		this._cameraFar = reference( 'far', 'float', camera );
		this._denoiseRenderTarget = createGtvbaoRenderTarget( GTVBAO_PASS_NAMES.denoise, RedFormat );
		this._material = new NodeMaterial();
		this._material.name = GTVBAO_PASS_NAMES.denoise;
		this._textureNode = passTexture( this, this._denoiseRenderTarget.texture );
		this._lastSize = { width: 0, height: 0 };
		this._fragmentContext = null;
		this._logarithmicDepthBuffer = false;
		this._fragmentLinearDepthNode = null;
	}
	get normalEncoding() {
		return this._normalEncoding;
	}
	updateBefore( frame ) {
		this._updateDenoiseRotationIndex( frame.frameId ?? 0 );
		// Rebuild when the AO source or its useDepthMips variant changes.
		if ( this._fragmentContext !== null && this._fragmentLinearDepthNode !== this._getLinearDepthNode() ) this._refreshMaterialFragmentNode();
		const map = this.textureNode.value;
		const width = Math.max( 1, map.image.width );
		const height = Math.max( 1, map.image.height );
		if ( this._lastSize.width !== width || this._lastSize.height !== height ) {
			this._lastSize.width = width;
			this._lastSize.height = height;
			this._resolution.value.set( width, height );
			this._denoiseRenderTarget.setSize( width, height );
		}
		const { renderer } = frame;
		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );
		_quadMesh.material = this._material;
		_quadMesh.name = GTVBAO_PASS_NAMES.denoise;
		renderer.setRenderTarget( this._denoiseRenderTarget );
		_quadMesh.render( renderer );
		this._textureNode.value = this._denoiseRenderTarget.texture;
		RendererUtils.restoreRendererState( renderer, _rendererState );
	}
	dispose() {
		this.noiseNode?.value?.dispose?.();
		this._denoiseRenderTarget.dispose();
		this._material.dispose();
	}
	_getNoiseNode() {
		if ( this.noiseNode === null ) this.noiseNode = texture( generateDefaultNoise() );
		return this.noiseNode;
	}
	_updateDenoiseRotationIndex( frameId ) {
		if ( this.useTemporalDenoiseRotation === true ) this.index.value = frameId % 4;
	}
	// The denoised AO as a texture, for consumers that sample it at their own
	// coordinates (a lit scene pass samples at the screen position, not at uv()).
	getTextureNode() {
		return this._textureNode;
	}
	setup( builder ) {
		this._fragmentContext = builder.getSharedContext();
		this._logarithmicDepthBuffer = builder.renderer.logarithmicDepthBuffer === true && ! this._isOrthographicCamera;
		this._refreshMaterialFragmentNode();
		return this._textureNode.r;
	}
	_getLinearDepthNode() {
		return this.linearDepthSource !== null && this.linearDepthSource.useDepthMips.value
			? this.linearDepthSource.getDepthMipNodes()[ 0 ]
			: null;
	}
	_refreshMaterialFragmentNode() {
		this._fragmentLinearDepthNode = this._getLinearDepthNode();
		this._material.fragmentNode = this._createFragmentNode();
		this._material.needsUpdate = true;
	}
	_createFragmentNode() {
		const uvNode = uv();
		const noiseNode = this._getNoiseNode();
		const depthResolution = vec2( textureSize( this.depthNode, 0 ) ).toConst();
		const maxDepthTexel = depthResolution.sub( 1 ).toConst();
		const linearDepthNode = this._fragmentLinearDepthNode;
		const aoResolution = linearDepthNode === null ? null : vec2( textureSize( linearDepthNode, 0 ) ).toConst();
		const viewPositionFromLinearDepth = linearDepthNode === null ? null : createViewPositionFromLinearDepth( this._cameraProjectionMatrixInverse, this._isOrthographicCamera );
		// Level-0 texels stand for the scene-depth texel selected by this expression
		// (shared with the prefilter), so reconstruct at that texel's center.
		const viewPositionAt = ( sampleUv, depth ) => {
			if ( linearDepthNode === null ) return getViewPosition( sampleUv, depth, this._cameraProjectionMatrixInverse, this._isOrthographicCamera );
			const aoTexel = min( floor( sampleUv.mul( aoResolution ) ), aoResolution.sub( 1 ) ).toConst();
			const sourceTexel = depthTexelOfAoTexel( aoTexel, depthResolution, aoResolution );
			const sourceUv = sourceTexel.add( 0.5 ).div( depthResolution );
			return viewPositionFromLinearDepth( sourceUv, linearDepthNode.load( ivec2( aoTexel ) ).r );
		};
		const sampleAo = ( sampleUv ) => this.textureNode.sample( sampleUv ).r;
		// Unfiltered depth is fetched by texel directly; three's sampler path would
		// expand each fetch into a wrap function plus clamp. The min keeps a UV of
		// exactly 1 (from the clamped neighbor UVs) on the last texel, matching
		// the sampler path's clamp-to-edge.
		const convertDepth = ( depth ) => {
			if ( this._logarithmicDepthBuffer ) {
				const viewZ = logarithmicDepthToViewZ( depth, this._cameraNear, this._cameraFar );
				return viewZToPerspectiveDepth( viewZ, this._cameraNear, this._cameraFar );
			}
			return depth;
		};
		const loadDepth = ( sampleUv ) => convertDepth( this.depthNode.load( ivec2( min( floor( sampleUv.mul( depthResolution ) ), maxDepthTexel ) ) ).r );
		const sampleNormal = ( sampleUv ) => {
			if ( this.normalNode === null ) return getDepthNormal( sampleUv, this.depthNode, this._cameraProjectionMatrixInverse, this._isOrthographicCamera, convertDepth );
			const normal = this.normalNode.sample( sampleUv ).rgb;
			return this._normalEncoding === 'directionToColor' ? normal.mul( 2 ).sub( 1 ).normalize() : normal.normalize();
		};
		const sampleNoise = ( sampleUv ) => noiseNode.sample( sampleUv );
		const denoise = Fn( ( [ sampleUv ] ) => {
			const depth = loadDepth( sampleUv ).toVar();
			const viewNormal = sampleNormal( sampleUv ).toVar();
			const centerAo = sampleAo( sampleUv ).toVar();
			const result = property( 'float' );
			If( depth.greaterThanEqual( 1 ).or( dot( viewNormal, viewNormal ).equal( 0 ) ), () => {
				result.assign( centerAo );
			} ).Else( () => {
				const viewPosition = viewPositionAt( sampleUv, depth ).toConst();
				const noiseResolution = textureSize( noiseNode, 0 );
				let noiseUv = vec2( sampleUv.x, sampleUv.y.oneMinus() );
				noiseUv = noiseUv.mul( this._resolution.div( noiseResolution ) );
				const noiseTexel = sampleNoise( noiseUv ).toVar();
				const angle = noiseTexel.element( int( this.index.mod( 4 ) ) ).mul( PI ).mul( 2 );
				const c = cos( angle );
				const s = sin( angle );
				const rotationMatrix = mat2( c, s.negate(), s, c );
				const totalWeight = float( 1 ).toVar();
				const denoisedAo = centerAo.toVar();
				// These uniforms are invariant across the fixed kernel; reciprocal
				// multiplication avoids repeating three divisions for every sample.
				const invLumaPhi = float( 1 ).div( this.lumaPhi ).toConst();
				const invDepthPhi = float( 1 ).div( this.depthPhi ).toConst();
				const invResolution = vec2( 1 ).div( this._resolution ).toConst();
				const radiusScale = this.radius.sub( 1 ).toConst();
				// Unrolled in JS: with the kernel baked in, no fetch address depends on a
				// loop counter, so the compiler can issue the 48 texture fetches together
				// instead of paying one fetch latency per iteration.
				for ( const sampleDir of DENOISE_SAMPLES ) {
					const sampleOffset = vec2( sampleDir.x, sampleDir.y ).mul( float( 1 ).add( radiusScale.mul( sampleDir.z ) ) );
					const offset = rotationMatrix.mul( sampleOffset ).mul( invResolution );
					const neighborUv = clamp( sampleUv.add( offset ), 0, 1 ).toConst();
					const neighborAo = sampleAo( neighborUv ).toConst();
					const neighborNormal = sampleNormal( neighborUv ).toConst();
					// The scene-depth fetch is only needed without the linear-depth source.
					const neighborViewPosition = viewPositionAt( neighborUv, linearDepthNode === null ? loadDepth( neighborUv ) : null ).toConst();
					const normalSimilarity = pow( max( dot( viewNormal, neighborNormal ), 0 ), this.normalPhi );
					const lumaDiff = abs( neighborAo.sub( centerAo ) );
					const lumaSimilarity = max( float( 1 ).sub( lumaDiff.mul( invLumaPhi ) ), 0 );
					const depthDiff = abs( dot( viewPosition.sub( neighborViewPosition ), viewNormal ) );
					const depthSimilarity = max( float( 1 ).sub( depthDiff.mul( invDepthPhi ) ), 0 );
					const weight = lumaSimilarity.mul( depthSimilarity ).mul( normalSimilarity ).toConst();
					denoisedAo.addAssign( neighborAo.mul( weight ) );
					totalWeight.addAssign( weight );
				}
				If( totalWeight.greaterThan( float( 0 ) ), () => {
					denoisedAo.divAssign( totalWeight );
				} );
				result.assign( denoisedAo );
			} );
			return result;
		} );
		const denoisePass = Fn( () => {
			return vec4( vec3( denoise( uvNode ) ), 1 );
		} );
		return denoisePass().context( this._fragmentContext );
	}
}
export default GTVBAODenoiseNode;
function generateDenoiseSamples( numSamples, numRings, radiusExponent ) {
	const samples = [];
	for ( let i = 0; i < numSamples; i ++ ) {
		const angle = 2 * Math.PI * numRings * i / numSamples;
		const radius = Math.pow( i / ( numSamples - 1 ), radiusExponent );
		samples.push( { x: Math.cos( angle ), y: Math.sin( angle ), z: radius } );
	}
	return samples;
}
function generateDefaultNoise( size = 64 ) {
	const simplex = new SimplexNoise();
	const data = new Uint8Array( size * size * 4 );
	for ( let i = 0; i < size; i ++ ) {
		for ( let j = 0; j < size; j ++ ) {
			const offset = ( i * size + j ) * 4;
			data[ offset ] = ( simplex.noise( i, j ) * 0.5 + 0.5 ) * 255;
			data[ offset + 1 ] = ( simplex.noise( i + size, j ) * 0.5 + 0.5 ) * 255;
			data[ offset + 2 ] = ( simplex.noise( i, j + size ) * 0.5 + 0.5 ) * 255;
			data[ offset + 3 ] = ( simplex.noise( i + size, j + size ) * 0.5 + 0.5 ) * 255;
		}
	}
	const noiseTexture = new DataTexture( data, size, size );
	noiseTexture.wrapS = RepeatWrapping;
	noiseTexture.wrapT = RepeatWrapping;
	noiseTexture.needsUpdate = true;
	return noiseTexture;
}
export const gtvbaoDenoise = ( node, depthNode, normalNode, camera, options ) => new GTVBAODenoiseNode( convertToTexture( node ), nodeObject( depthNode ), normalNode === null ? null : nodeObject( normalNode ), camera, options );
