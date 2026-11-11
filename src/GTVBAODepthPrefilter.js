import { FloatType, NearestFilter, NodeMaterial, QuadMesh, RedFormat, RenderTarget, RendererUtils, StorageTexture, Vector2 } from 'three/webgpu';
import {
	Fn,
	If,
	computeKernel,
	float,
	instanceIndex,
	ivec2,
	logarithmicDepthToViewZ,
	max,
	min,
	orthographicDepthToViewZ,
	perspectiveDepthToViewZ,
	storageTexture,
	texture,
	textureStore,
	uint,
	uniform,
	uv,
	uvec2,
	vec2,
	vec4
} from 'three/tsl';
export const GTVBAO_DEPTH_MIP_COUNT = 5;
const WORKGROUP_SIZE = [ 64 ];
const MAX_WORKGROUPS_PER_DIMENSION = 65535; // WebGPU's guaranteed minimum limit.
const dispatchSizeOf = ( count ) => {
	const groups = Math.ceil( count / WORKGROUP_SIZE[ 0 ] );
	return groups > MAX_WORKGROUPS_PER_DIMENSION
		? [ MAX_WORKGROUPS_PER_DIMENSION, Math.ceil( groups / MAX_WORKGROUPS_PER_DIMENSION ), 1 ]
		: [ groups, 1, 1 ];
};
export const sceneDepthToLinearDepth = ( depth, cameraNear, cameraFar, isOrthographicCamera, logarithmicDepthBuffer ) => {
	if ( isOrthographicCamera ) return orthographicDepthToViewZ( depth, cameraNear, cameraFar ).negate();
	const viewZ = logarithmicDepthBuffer
		? logarithmicDepthToViewZ( depth, cameraNear, cameraFar )
		: perspectiveDepthToViewZ( depth, cameraNear, cameraFar );
	return viewZ.negate();
};
// Scene-depth texel represented by an AO texel: the depth texel under the AO
// texel's center, floor( ( t + 0.5 ) * D / A ), evaluated as the integer
// quotient ( ( 2t + 1 ) * D ) / ( 2A ). The float form lands on either side of
// an integer when D / A is integral (resolution scale 0.5 or 0.25 at pixel
// ratios that make D = 2A or 4A), and the compute and fragment compilers round
// it differently, so the prefilter and the AO shader picked rows one texel
// apart. Integer arithmetic makes every consumer agree exactly.
export const depthTexelOfAoTexel = ( aoTexel, depthResolution, aoResolution ) =>
	vec2( ivec2( aoTexel ).mul( 2 ).add( 1 ).mul( ivec2( depthResolution ) ).div( ivec2( aoResolution ).mul( 2 ) ) );
// Depth-aware downsample after XeGTAO: samples nearer than the farthest sample
// of a 2x2 block by more than the depth range fade out, so a block straddling a
// depth discontinuity keeps the far surface instead of averaging into a point
// floating in front of it (which reads as false occlusion). The range is the
// AO's maximum thickness, a world-space scale, rather than the radius, which is
// a screen-space factor in this project.
const FALLOFF_RANGE = 0.615;
const createStorageTexture = ( width, height ) => {
	const storageTexture = new StorageTexture( width, height );
	storageTexture.format = RedFormat;
	storageTexture.type = FloatType;
	storageTexture.magFilter = NearestFilter;
	storageTexture.minFilter = NearestFilter;
	storageTexture.generateMipmaps = false;
	return storageTexture;
};
const halfSize = ( size ) => size.add( uint( 1 ) ).div( uint( 2 ) );
const quadMesh = /*@__PURE__*/ new QuadMesh();
let _rendererState;
const filterConstants = ( depthRangeNode ) => {
	const depthRange = depthRangeNode.max( 1e-4 );
	const falloffRange = depthRange.mul( FALLOFF_RANGE );
	return {
		falloffMul: float( - 1 ).div( falloffRange ).toConst(),
		falloffAdd: depthRange.mul( 1 - FALLOFF_RANGE ).div( falloffRange ).add( 1 ).toConst()
	};
};
const filterDepths = ( { falloffMul, falloffAdd }, d0, d1, d2, d3 ) => {
	const maxDepth = max( max( d0, d1 ), max( d2, d3 ) ).toConst();
	const weight = ( depth ) => maxDepth.sub( depth ).mul( falloffMul ).add( falloffAdd ).clamp().toConst();
	const w0 = weight( d0 );
	const w1 = weight( d1 );
	const w2 = weight( d2 );
	const w3 = weight( d3 );
	// The farthest sample always has weight 1, so the sum is never zero.
	return d0.mul( w0 ).add( d1.mul( w1 ) ).add( d2.mul( w2 ) ).add( d3.mul( w3 ) ).div( w0.add( w1 ).add( w2 ).add( w3 ) );
};
const filterFrom = ( constants, load, texelX, texelY ) => {
	const x0 = texelX.mul( uint( 2 ) ).toConst();
	const y0 = texelY.mul( uint( 2 ) ).toConst();
	const x1 = x0.add( uint( 1 ) ).toConst();
	const y1 = y0.add( uint( 1 ) ).toConst();
	return filterDepths( constants, load( x0, y0 ), load( x1, y0 ), load( x0, y1 ), load( x1, y1 ) );
};
// Builds a linear-depth (positive view-space distance) MIP chain at AO
// resolution from the full-resolution scene depth. Far AO steps use coarser
// levels whose smaller footprints stay in cache, and their per-sample
// perspective divide disappears. Level 0 supplies the denoiser and upsample;
// the AO center derives the same linear depth from its scene-depth fetch.
//
// Level 0 decimates the scene depth with exactly the texel selection the AO
// shader uses for its center pixel, so levels 1..4 apply the depth-aware filter
// to 2x2 blocks of the previous level. WebGPU uses two compute dispatches in
// one pass (0+1, then 2..4 from level 1); WebGL2 uses five float render-target
// passes: level 1 filters level 0, which holds exactly the values decimate
// would produce. Levels 2..4 recursively filter level 1 as on WebGPU.
//
// Sizes enter the shaders as uniforms and dispatch sizes are updated per node,
// so a resize only reallocates textures; shaders compile once per depth
// mode on either backend.
class GTVBAODepthPrefilter {
	constructor( depthNode, cameraNear, cameraFar, depthRange, isOrthographicCamera = false ) {
		this._depthNode = depthNode;
		this._isOrthographicCamera = isOrthographicCamera;
		this._cameraNear = cameraNear;
		this._cameraFar = cameraFar;
		this._depthRange = depthRange;
		this._logarithmicDepthBuffer = false;
		this._sizes = [];
		this._dispatchSizes = [];
		this._textures = [];
		this._placeholders = Array.from( { length: GTVBAO_DEPTH_MIP_COUNT }, () => createStorageTexture( 1, 1 ) );
		this._textureNodes = this._placeholders.map( ( placeholder ) => texture( placeholder ) );
		this._storeNodes = this._textureNodes.map( ( textureNode ) => storageTexture( textureNode.value ) );
		this._aoResolution = uniform( new Vector2() );
		this._depthResolution = uniform( new Vector2() );
		this._kernels = null;
		this._materials = null;
		this._targets = [];
		this._useRenderPasses = false;
		this._width = 0;
		this._height = 0;
		this._depthWidth = 0;
		this._depthHeight = 0;
	}
	get mipTextureNodes() {
		return this._textureNodes;
	}
	setLogarithmicDepthBuffer( value ) {
		if ( this._logarithmicDepthBuffer === value ) return;
		this._logarithmicDepthBuffer = value;
		this._disposeKernels();
	}
	setSize( width, height, depthWidth, depthHeight ) {
		if ( this._width === width && this._height === height && this._depthWidth === depthWidth && this._depthHeight === depthHeight ) return;
		this._width = width;
		this._height = height;
		this._depthWidth = depthWidth;
		this._depthHeight = depthHeight;
		this._aoResolution.value.set( width, height );
		this._depthResolution.value.set( depthWidth, depthHeight );
		this._sizes = [ { width, height } ];
		for ( let level = 1; level < GTVBAO_DEPTH_MIP_COUNT; level ++ ) {
			const previous = this._sizes[ level - 1 ];
			this._sizes.push( { width: Math.ceil( previous.width / 2 ), height: Math.ceil( previous.height / 2 ) } );
		}
		const [ , size1, size2 ] = this._sizes;
		this._dispatchSizes = [ dispatchSizeOf( size1.width * size1.height ), dispatchSizeOf( size2.width * size2.height ) ];
		this._disposeTextures();
		this._allocateTextures();
	}
	release() {
		if ( this._textures.length === 0 ) return;
		this._disposeTextures();
		this._sizes = [];
		this._dispatchSizes = [];
		this._width = 0;
		this._height = 0;
		this._depthWidth = 0;
		this._depthHeight = 0;
		for ( let level = 0; level < GTVBAO_DEPTH_MIP_COUNT; level ++ ) {
			this._textureNodes[ level ].value = this._placeholders[ level ];
			this._storeNodes[ level ].value = this._placeholders[ level ];
		}
	}
	_allocateTextures() {
		this._textures = this._sizes.map( ( { width, height }, level ) => {
			if ( ! this._useRenderPasses ) return createStorageTexture( width, height );
			const target = new RenderTarget( width, height, { depthBuffer: false, format: RedFormat, type: FloatType, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false } );
			target.texture.name = `GTVBAO.DepthMip.${ level }`;
			this._targets.push( target );
			return target.texture;
		} );
		for ( let level = 0; level < GTVBAO_DEPTH_MIP_COUNT; level ++ ) {
			this._textureNodes[ level ].value = this._textures[ level ];
			this._storeNodes[ level ].value = this._textures[ level ];
		}
	}
	compute( renderer ) {
		if ( this._textures.length === 0 ) return;
		if ( renderer.backend?.isWebGLBackend === true ) {
			if ( ! this._useRenderPasses ) {
				this._useRenderPasses = true;
				this._disposeTextures();
				this._allocateTextures();
			}
			this._renderDepthMips( renderer );
			return;
		}
		if ( this._kernels === null ) this._kernels = this._buildKernels();
		// three r184-r187 run a node array in one command encoder/compute pass,
		// using each node's dispatchSize when no size argument is given.
		// instanceIndex flattens global IDs using workgroup counts, so a 2D split
		// keeps the same indexing. Padding is harmless: A guards y < size1.y;
		// B's out-of-range stores are dropped and its loads are clamped.
		for ( let i = 0; i < this._kernels.length; i ++ ) this._kernels[ i ].dispatchSize = this._dispatchSizes[ i ];
		renderer.compute( this._kernels );
	}
	dispose() {
		this._disposeKernels();
		this._disposeTextures();
		for ( const placeholder of this._placeholders ) placeholder.dispose();
	}
	_disposeKernels() {
		for ( const kernel of this._kernels ?? [] ) kernel.dispose();
		for ( const material of this._materials ?? [] ) material.dispose();
		this._kernels = null;
		this._materials = null;
	}
	_disposeTextures() {
		if ( this._targets.length > 0 ) {
			for ( const target of this._targets ) target.dispose();
		} else {
			for ( const storageTexture of this._textures ) storageTexture.dispose();
		}
		this._targets = [];
		this._textures = [];
	}
	_linearDepth( depth ) {
		return sceneDepthToLinearDepth( depth, this._cameraNear, this._cameraFar, this._isOrthographicCamera, this._logarithmicDepthBuffer );
	}
	_renderDepthMips( renderer ) {
		if ( this._materials === null ) this._materials = this._buildFragmentMaterials();
		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );
		try {
			for ( let level = 0; level < GTVBAO_DEPTH_MIP_COUNT; level ++ ) {
				quadMesh.material = this._materials[ level ];
				quadMesh.name = this._targets[ level ].texture.name;
				renderer.setRenderTarget( this._targets[ level ] );
				quadMesh.render( renderer );
			}
		} finally {
			RendererUtils.restoreRendererState( renderer, _rendererState );
		}
	}
	_buildFragmentMaterials() {
		return Array.from( { length: GTVBAO_DEPTH_MIP_COUNT }, ( _, level ) => {
			const material = new NodeMaterial();
			material.name = `GTVBAO.DepthMip.${ level }`;
			material.fragmentNode = Fn( () => {
				const size0 = uvec2( this._aoResolution ).toConst();
				const size1 = halfSize( size0 ).toConst();
				let size = size0;
				for ( let index = 0; index < level; index ++ ) size = halfSize( size );
				// QuadMesh UVs and TextureNode.load use top-left texel coordinates
				// on both backends; Three applies the WebGL render-target Y flip.
				const texel = uvec2( uv().mul( vec2( size ) ) ).toConst();
				const decimate = ( x, y ) => {
					const aoTexel = min( uvec2( x, y ), size0.sub( uint( 1 ) ) );
					const source = depthTexelOfAoTexel( aoTexel, this._depthResolution, this._aoResolution );
					return this._linearDepth( this._depthNode.load( ivec2( source ) ).r );
				};
				if ( level === 0 ) return vec4( decimate( texel.x, texel.y ) );
				const constants = filterConstants( this._depthRange );
				if ( level === 1 ) {
					const maxTexel0 = ivec2( size0.sub( uint( 1 ) ) ).toConst();
					const loadLevel0 = ( x, y ) => this._textureNodes[ 0 ].load( min( ivec2( x, y ), maxTexel0 ) ).r;
					return vec4( filterFrom( constants, loadLevel0, texel.x, texel.y ) );
				}
				const maxTexel1 = ivec2( size1.sub( uint( 1 ) ) ).toConst();
				let load = ( x, y ) => this._textureNodes[ 1 ].load( min( ivec2( x, y ), maxTexel1 ) ).r;
				// Match the compute kernel's recursive sampling from level 1.
				// Clamping each intermediate mip instead changes odd-edge values.
				for ( let index = 2; index <= level; index ++ ) {
					const previous = load;
					load = ( x, y ) => filterFrom( constants, previous, x, y );
				}
				return vec4( load( texel.x, texel.y ) );
			} )();
			return material;
		} );
	}
	_buildKernels() {
		// textureStore() clones the node with the texture it holds at build time;
		// pointing the clone back at the persistent node makes later swaps of
		// `.value` (a resize) reach the compiled kernel, like `.load()` does.
		const store = ( level, texelX, texelY, value ) => {
			const storeNode = textureStore( this._storeNodes[ level ], uvec2( texelX, texelY ), vec4( value ) );
			storeNode.referenceNode = this._storeNodes[ level ];
			return storeNode;
		};
		const kernelA = computeKernel( Fn( () => {
			const size0 = uvec2( this._aoResolution ).toConst();
			const size1 = halfSize( size0 ).toConst();
			const x = instanceIndex.mod( size1.x ).toConst();
			const y = instanceIndex.div( size1.x ).toConst();
			// One invocation owns a 2x2 block: reuse its four linearized depths for
			// both levels instead of fetching three of them again for level 1.
			If( y.lessThan( size1.y ), () => {
				const constants = filterConstants( this._depthRange );
				const depthResolution = this._depthResolution.toConst();
				const aoResolution = this._aoResolution.toConst();
				const maxAoTexel = size0.sub( uint( 1 ) ).toConst();
				const decimate = ( texelX, texelY ) => {
					const aoTexel = min( uvec2( texelX, texelY ), maxAoTexel );
					const source = depthTexelOfAoTexel( aoTexel, depthResolution, aoResolution );
					return this._linearDepth( this._depthNode.load( ivec2( source ) ).r );
				};
				const x0 = x.mul( uint( 2 ) ).toConst();
				const y0 = y.mul( uint( 2 ) ).toConst();
				const x1 = x0.add( uint( 1 ) ).toConst();
				const y1 = y0.add( uint( 1 ) ).toConst();
				const d0 = decimate( x0, y0 ).toConst();
				const d1 = decimate( x1, y0 ).toConst();
				const d2 = decimate( x0, y1 ).toConst();
				const d3 = decimate( x1, y1 ).toConst();
				// Odd edges repeat the last texel for filtering. Keep store coordinates
				// unclamped: out-of-bounds writes are discarded, with no shared writers.
				store( 0, x0, y0, d0 );
				store( 0, x1, y0, d1 );
				store( 0, x0, y1, d2 );
				store( 0, x1, y1, d3 );
				store( 1, x, y, filterDepths( constants, d0, d1, d2, d3 ) );
			} );
		} )(), WORKGROUP_SIZE );
		const kernelB = computeKernel( Fn( () => {
			const constants = filterConstants( this._depthRange );
			const size1 = halfSize( uvec2( this._aoResolution ) ).toConst();
			const size2 = halfSize( size1 ).toConst();
			const x2 = instanceIndex.mod( size2.x ).toConst();
			const y2 = instanceIndex.div( size2.x ).toConst();
			const maxTexel1 = ivec2( size1.sub( uint( 1 ) ) ).toConst();
			const loadLevel1 = ( texelX, texelY ) => this._textureNodes[ 1 ].load( min( ivec2( texelX, texelY ), maxTexel1 ) ).r;
			// Reuse this invocation's top-left result in its parent filter. Other
			// children still read level 1, preserving virtual texels at odd edges.
			const level2At = ( texelX, texelY ) => filterFrom( constants, loadLevel1, texelX, texelY );
			const level3At = ( texelX, texelY ) => filterFrom( constants, level2At, texelX, texelY );
			const depth2 = level2At( x2, y2 ).toConst();
			store( 2, x2, y2, depth2 );
			If( x2.mod( uint( 2 ) ).equal( uint( 0 ) ).and( y2.mod( uint( 2 ) ).equal( uint( 0 ) ) ), () => {
				const x3 = x2.div( uint( 2 ) ).toConst();
				const y3 = y2.div( uint( 2 ) ).toConst();
				const depth3 = filterDepths( constants, depth2,
					level2At( x2.add( uint( 1 ) ), y2 ),
					level2At( x2, y2.add( uint( 1 ) ) ),
					level2At( x2.add( uint( 1 ) ), y2.add( uint( 1 ) ) ) ).toConst();
				store( 3, x3, y3, depth3 );
				If( x2.mod( uint( 4 ) ).equal( uint( 0 ) ).and( y2.mod( uint( 4 ) ).equal( uint( 0 ) ) ), () => {
					const x4 = x2.div( uint( 4 ) ).toConst();
					const y4 = y2.div( uint( 4 ) ).toConst();
					store( 4, x4, y4, filterDepths( constants, depth3,
						level3At( x3.add( uint( 1 ) ), y3 ),
						level3At( x3, y3.add( uint( 1 ) ) ),
						level3At( x3.add( uint( 1 ) ), y3.add( uint( 1 ) ) ) ) );
				} );
			} );
		} )(), WORKGROUP_SIZE );
		return [ kernelA, kernelB ];
	}
}
export default GTVBAODepthPrefilter;
