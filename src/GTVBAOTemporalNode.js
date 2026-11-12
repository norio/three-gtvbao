import {
	ClampToEdgeWrapping,
	HalfFloatType,
	LinearFilter,
	Matrix4,
	NearestFilter,
	NodeMaterial,
	NodeUpdateType,
	QuadMesh,
	RenderTarget,
	RendererUtils,
	RGBAFormat
} from 'three/webgpu';
import {
	Fn,
	If,
	abs,
	clamp,
	convertToTexture,
	cross,
	dot,
	float,
	floor,
	fract,
	ivec2,
	length,
	logarithmicDepthToViewZ,
	max,
	min,
	nodeObject,
	normalize,
	passTexture,
	sqrt,
	texture,
	textureSize,
	uniform,
	uv,
	vec2,
	vec3,
	vec4,
	viewZToPerspectiveDepth
} from 'three/tsl';
import { getGtvbaoContextSignature } from './GTVBAOContextSignature.js';
import { getDepthNormal } from './GTVBAODepthNormal.js';
import { depthTexelOfAoTexel, sceneDepthToLinearDepth } from './GTVBAODepthPrefilter.js';
import { GTVBAONodeBase } from './GTVBAONodeBase.js';
import { GTVBAO_PASS_NAMES } from './GTVBAOPassNames.js';
import { createViewPositionFromLinearDepth } from './GTVBAOViewSpace.js';

const PLANE_TOLERANCE_TEXELS = 2;
const _quadMesh = /*@__PURE__*/ new QuadMesh();
let _rendererState;

// AO, positive linear depth and history length need more than an 8-bit target.
const createTemporalRenderTarget = ( filter ) => {
	const target = new RenderTarget( 1, 1, { depthBuffer: false, type: HalfFloatType, format: RGBAFormat } );
	target.texture.generateMipmaps = false;
	target.texture.minFilter = filter;
	target.texture.magFilter = filter;
	target.texture.wrapS = ClampToEdgeWrapping;
	target.texture.wrapT = ClampToEdgeWrapping;
	return target;
};

class GTVBAOTemporalNode extends GTVBAONodeBase {
	static get type() {
		return 'GTVBAOTemporalNode';
	}
	constructor( textureNode, velocityNode, aoNode, options = {} ) {
		super( 'float' );
		this.textureNode = textureNode;
		this.velocityNode = velocityNode;
		this.aoNode = aoNode;
		this.blend = uniform( options.blend ?? 0.1 );
		this.clampSigma = uniform( options.clampSigma ?? 1.5 );
		this.parallaxBlend = uniform( options.parallaxBlend ?? 20 );
		this.updateBeforeType = NodeUpdateType.FRAME;
		this._reprojection = uniform( new Matrix4() );
		this._historyValid = uniform( 0 );
		this._previousMatrixWorld = new Matrix4();
		this._resolveRenderTarget = createTemporalRenderTarget( LinearFilter );
		this._resolveRenderTarget.texture.name = GTVBAO_PASS_NAMES.temporal;
		this._historyRenderTarget = createTemporalRenderTarget( NearestFilter );
		this._historyNode = texture( this._historyRenderTarget.texture ).setUpdateMatrix( false );
		this._textureNode = passTexture( this, this._resolveRenderTarget.texture );
		this._material = new NodeMaterial();
		this._material.name = GTVBAO_PASS_NAMES.temporal;
		this._lastSize = { width: 0, height: 0 };
		this._fragmentContext = null;
		this._fragmentInputs = null;
		this._logarithmicDepthBuffer = false;
	}
	getTextureNode() {
		return this._textureNode;
	}
	// Call after a camera cut or re-entering the output graph after a long absence.
	reset() {
		this._historyValid.value = 0;
	}
	updateBefore( frame ) {
		const { renderer } = frame;
		const map = this.textureNode.value;
		const width = Math.max( 1, map.image.width );
		const height = Math.max( 1, map.image.height );
		if ( this._lastSize.width !== width || this._lastSize.height !== height ) {
			this._lastSize.width = width;
			this._lastSize.height = height;
			this._resolveRenderTarget.setSize( width, height );
			this._historyRenderTarget.setSize( width, height );
			// r184 requires initialized render targets before copyTextureToTexture().
			renderer.initRenderTarget( this._resolveRenderTarget );
			renderer.initRenderTarget( this._historyRenderTarget );
			this.reset();
		}
		const camera = this.aoNode._camera;
		this._reprojection.value.multiplyMatrices( camera.matrixWorldInverse, this._previousMatrixWorld );
		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );
		try {
			_quadMesh.material = this._material;
			_quadMesh.name = GTVBAO_PASS_NAMES.temporal;
			renderer.setRenderTarget( this._resolveRenderTarget );
			_quadMesh.render( renderer );
			renderer.copyTextureToTexture( this._resolveRenderTarget.texture, this._historyRenderTarget.texture );
		} finally {
			RendererUtils.restoreRendererState( renderer, _rendererState );
		}
		this._previousMatrixWorld.copy( camera.matrixWorld );
		this._historyValid.value = 1;
	}
	dispose() {
		this._resolveRenderTarget.dispose();
		this._historyRenderTarget.dispose();
		this._material.dispose();
	}
	setup( builder ) {
		this._fragmentContext = builder.getSharedContext();
		this._logarithmicDepthBuffer = builder.renderer.logarithmicDepthBuffer === true && ! this.aoNode._isOrthographicCamera;
		this._refreshMaterialFragmentNode();
		return this._textureNode.r;
	}
	_refreshMaterialFragmentNode() {
		const aoNode = this.aoNode;
		const inputs = [
			this.textureNode,
			this.velocityNode,
			aoNode,
			aoNode.depthNode,
			aoNode.normalNode,
			aoNode.normalEncoding,
			aoNode._cameraProjectionMatrixInverse,
			aoNode._cameraNear,
			aoNode._cameraFar,
			aoNode._isOrthographicCamera,
			aoNode._halfProjScale,
			this._logarithmicDepthBuffer,
			getGtvbaoContextSignature( this._fragmentContext )
		];
		// Multiple consumer materials can call setup with equivalent contexts.
		if ( this._fragmentInputs !== null && inputs.every( ( input, index ) => input === this._fragmentInputs[ index ] ) ) return;
		this._fragmentInputs = inputs;
		this._material.fragmentNode = this._createFragmentNode();
		this._material.needsUpdate = true;
		this.reset();
	}
	_createFragmentNode() {
		const aoNode = this.aoNode;
		const aoResolution = vec2( textureSize( this.textureNode, 0 ) ).toConst();
		const depthResolution = vec2( textureSize( aoNode.depthNode, 0 ) ).toConst();
		const invDepthResolution = vec2( 1 ).div( depthResolution ).toConst();
		const maxAoTexel = aoResolution.sub( 1 ).toConst();
		const planeToleranceScale = float( PLANE_TOLERANCE_TEXELS / 2 ).div( aoNode._halfProjScale ).toConst();
		const viewPositionFromLinearDepth = createViewPositionFromLinearDepth( aoNode._cameraProjectionMatrixInverse, aoNode._isOrthographicCamera );
		const convertDepth = ( depth ) => {
			if ( this._logarithmicDepthBuffer ) {
				const viewZ = logarithmicDepthToViewZ( depth, aoNode._cameraNear, aoNode._cameraFar );
				return viewZToPerspectiveDepth( viewZ, aoNode._cameraNear, aoNode._cameraFar );
			}
			return depth;
		};
		const loadNormal = ( sampleUv ) => {
			if ( aoNode.normalNode === null ) {
				return getDepthNormal( sampleUv, aoNode.depthNode, aoNode._cameraProjectionMatrixInverse, aoNode._isOrthographicCamera, convertDepth );
			}
			const normalTexel = floor( sampleUv.mul( vec2( textureSize( aoNode.normalNode, 0 ) ) ) );
			const normal = aoNode.normalNode.load( ivec2( normalTexel ) ).rgb;
			return aoNode.normalEncoding === 'directionToColor' ? normal.mul( 2 ).sub( 1 ).normalize() : normal.normalize();
		};
		const temporalPass = Fn( () => {
			const uvNode = uv();
			const aoTexel = floor( uvNode.mul( aoResolution ) ).toConst();
			const sourceTexel = depthTexelOfAoTexel( aoTexel, depthResolution, aoResolution ).toConst();
			const rawDepth = aoNode.depthNode.load( ivec2( sourceTexel ) ).r.toConst();
			const currentAo = this.textureNode.load( ivec2( aoTexel ) ).r.toConst();
			const linearDepth = sceneDepthToLinearDepth( rawDepth, aoNode._cameraNear, aoNode._cameraFar, aoNode._isOrthographicCamera, this._logarithmicDepthBuffer ).toConst();
			const result = vec4( currentAo, linearDepth, 0, 1 ).toVar();
			If( rawDepth.lessThan( 1 ), () => {
				const surfaceUv = sourceTexel.add( 0.5 ).mul( invDepthResolution ).toConst();
				const viewPosition = viewPositionFromLinearDepth( surfaceUv, linearDepth ).toConst();
				const viewNormal = loadNormal( surfaceUv ).toConst();
				// three's velocity is current - previous in NDC, with Y pointing up.
				const velocityUv = this.velocityNode.load( ivec2( sourceTexel ) ).xy.mul( vec2( 0.5, - 0.5 ) ).toConst();
				const historyPosition = uvNode.sub( velocityUv ).mul( aoResolution ).sub( 0.5 ).toConst();
				const base = floor( historyPosition ).toConst();
				const blendXY = fract( historyPosition ).toConst();
				const footprintDepth = aoNode._isOrthographicCamera ? float( 1 ) : viewPosition.z.negate();
				const tolerance = footprintDepth.mul( planeToleranceScale ).add( 1e-4 ).toConst();
				const invTolerance = float( 1 ).div( tolerance ).toConst();
				const aoSum = float( 0 ).toVar();
				const countSum = float( 0 ).toVar();
				const weightSum = float( 0 ).toVar();
				for ( const [ x, y ] of [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ] ) {
					const texel = base.add( vec2( x, y ) ).toConst();
					const clampedTexel = clamp( texel, vec2( 0 ), maxAoTexel ).toConst();
					const h = this._historyNode.load( ivec2( clampedTexel ) ).setUpdateMatrix( false ).toConst();
					// Reconstruct at the scene-depth texel center represented by this AO texel.
					const historySourceTexel = depthTexelOfAoTexel( clampedTexel, depthResolution, aoResolution ).toConst();
					const previous = viewPositionFromLinearDepth( historySourceTexel.add( 0.5 ).mul( invDepthResolution ), h.g );
					const reprojected = this._reprojection.mul( vec4( previous, 1 ) ).xyz;
					const planeDistance = abs( dot( reprojected.sub( viewPosition ), viewNormal ) );
					const bilinear = ( x ? blendXY.x : blendXY.x.oneMinus() ).mul( y ? blendXY.y : blendXY.y.oneMinus() );
					// Clamp the fetch address, but reject corners outside the history.
					const inside = texel.x.greaterThanEqual( 0 ).and( texel.y.greaterThanEqual( 0 ) )
						.and( texel.x.lessThan( aoResolution.x ) ).and( texel.y.lessThan( aoResolution.y ) );
					const weight = bilinear.mul( planeDistance.mul( invTolerance ).oneMinus().clamp() )
						.mul( inside.select( 1, 0 ) ).mul( h.b.greaterThan( 0 ).select( 1, 0 ) ).toConst();
					aoSum.addAssign( h.r.mul( weight ) );
					countSum.addAssign( h.b.mul( weight ) );
					weightSum.addAssign( weight );
				}
				const valid = weightSum.greaterThan( 1e-3 ).and( this._historyValid.greaterThan( 0.5 ) ).toConst();
				const weightDenominator = max( weightSum, 1e-6 ).toConst();
				const historyCount = countSum.div( weightDenominator ).toConst();
				const sum = float( 0 ).toVar();
				const sumSquares = float( 0 ).toVar();
				const neighborhoodMin = float( 1 ).toVar();
				const neighborhoodMax = float( 0 ).toVar();
				for ( let y = - 1; y <= 1; y ++ ) {
					for ( let x = - 1; x <= 1; x ++ ) {
						const texel = clamp( aoTexel.add( vec2( x, y ) ), vec2( 0 ), maxAoTexel );
						const ao = this.textureNode.load( ivec2( texel ) ).r.toConst();
						sum.addAssign( ao );
						sumSquares.addAssign( ao.mul( ao ) );
						neighborhoodMin.assign( min( neighborhoodMin, ao ) );
						neighborhoodMax.assign( max( neighborhoodMax, ao ) );
					}
				}
				const mean = sum.div( 9 ).toConst();
				const sigma = sqrt( max( sumSquares.div( 9 ).sub( mean.mul( mean ) ), 0 ) ).toConst();
				const clampRange = this.clampSigma.mul( sigma ).toConst();
				const clampedHistoryAo = clamp( aoSum.div( weightDenominator ), mean.sub( clampRange ), mean.add( clampRange ) ).toConst();
				// This explicit select makes a flat neighborhood (especially neutral AO) pass through bit-exact.
				// Divisions and explicit lerp only reduce rounding elsewhere and are insufficient on their own:
				// WebGL2 compilers may rewrite them, and the float-to-half store may truncate.
				const historyAo = neighborhoodMax.equal( neighborhoodMin ).select( currentAo, clampedHistoryAo ).toConst();
				const nextCount = historyCount.add( 1 ).toConst();
				// Screen-space AO is view dependent: occluders previously edge-on or hidden contribute differently.
				// The neighborhood clamp does not catch these differences.
				// Use view-ray change: orbit-pivot points barely move on screen, while turning in place moves everything without changing any view ray.
				let parallax;
				if ( ! aoNode._isOrthographicCamera ) {
					const previousCameraPosition = this._reprojection.element( 3 ).xyz.toConst();
					const previousViewRay = viewPosition.sub( previousCameraPosition ).toConst();
					// The surface point can coincide with the previous camera position.
					const previousDirection = normalize( dot( previousViewRay, previousViewRay ).greaterThan( 0 ).select( previousViewRay, viewPosition ) ).toConst();
					parallax = length( cross( normalize( viewPosition ), previousDirection ) ).toConst();
				} else {
					const previousForward = this._reprojection.element( 2 ).xyz.negate().toConst();
					parallax = length( cross( vec3( 0, 0, - 1 ), normalize( previousForward ) ) ).toConst();
				}
				const alpha = valid.select( clamp( max( float( 1 ).div( nextCount ), this.blend ).add( parallax.mul( this.parallaxBlend ) ), 0, 1 ), 1 );
				result.assign( vec4( historyAo.add( currentAo.sub( historyAo ).mul( alpha ) ), linearDepth, valid.select( min( nextCount, 255 ), 1 ), 1 ) );
			} );
			return result;
		} );
		return temporalPass().context( this._fragmentContext );
	}
}

export default GTVBAOTemporalNode;
export const gtvbaoTemporal = ( aoTextureNode, velocityNode, aoNode, options = {} ) => new GTVBAOTemporalNode( convertToTexture( aoTextureNode ), nodeObject( velocityNode ), aoNode, options );
