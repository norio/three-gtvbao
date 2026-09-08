import {
	NodeMaterial,
	NodeUpdateType,
	QuadMesh,
	RedFormat,
	RendererUtils,
	RGBAFormat,
	TempNode,
	Vector2
} from 'three/webgpu';
import { passTexture, reference, uniform } from 'three/tsl';
import {
	GTVBAO_VARIANT_LIMITS,
	getGtvbaoDebugVariantKey,
	isGtvbaoDebugEnabled
} from './GTVBAODebugModes.js';
import GTVBAODepthPrefilter from './GTVBAODepthPrefilter.js';
import { createGtvbaoFragmentNode, isAoIntensityFastPath, isExpFactorFastPath } from './GTVBAOFragmentNode.js';
import { GTVBAO_PASS_NAMES } from './GTVBAOPassNames.js';
import { createGtvbaoRenderTarget } from './GTVBAORenderTarget.js';
import { GTVBAO_SECTOR_MEASURE_OPTIONS, normalizeGtvbaoSectorMeasure } from './GTVBAOSectorMeasure.js';
import { createGtvbaoDepthAwareAo, createGtvbaoDepthAwareAoFromBuffers } from './GTVBAOUpsample.js';
import { createGtvbaoVariantValue as createVariantValue, normalizeGtvbaoBool as normalizeBool, normalizeGtvbaoInt as normalizeInt, normalizeGtvbaoNumber as normalizeNumber } from './GTVBAOVariantValue.js';
const _quadMesh = /*@__PURE__*/ new QuadMesh();
const _size = /*@__PURE__*/ new Vector2();
const _temporalRotations = [ 60, 300, 180, 240, 120, 0 ];
const _spatialOffsets = [ 0, 0.5, 0.25, 0.75 ];
let _rendererState;
class GTVBAONode extends TempNode {
	static get type() {
		return 'GTVBAONode';
	}
	constructor( depthNode, normalNode, camera, options = {} ) {
		super( 'vec4' );
		this.depthNode = depthNode;
		this.normalNode = normalNode;
		this.normalEncoding = options.normalEncoding ?? 'view';
		this.updateBeforeType = NodeUpdateType.FRAME;
		this.sliceCount = createVariantValue( this, options.sliceCount ?? 2, normalizeInt( GTVBAO_VARIANT_LIMITS.sliceCount ) );
		this.stepCount = createVariantValue( this, options.stepCount ?? 8, normalizeInt( GTVBAO_VARIANT_LIMITS.stepCount ) );
		this.radius = uniform( options.radius ?? 3, 'float' );
		this.thickness = uniform( options.thickness ?? 0.12, 'float' );
		this._aoIntensityNode = uniform( options.aoIntensity ?? 1, 'float' );
		this.aoIntensity = createVariantValue( this, options.aoIntensity ?? 1, normalizeNumber( 1 ), { mirrorNode: this._aoIntensityNode, shouldRebuild: ( previousValue, nextValue ) => isAoIntensityFastPath( previousValue ) !== isAoIntensityFastPath( nextValue ) } );
		this._expFactorNode = uniform( options.expFactor ?? 2, 'float' );
		this.expFactor = createVariantValue( this, options.expFactor ?? 2, normalizeNumber( 2 ), { mirrorNode: this._expFactorNode, shouldRebuild: ( previousValue, nextValue ) => isExpFactorFastPath( previousValue ) !== isExpFactorFastPath( nextValue ) } );
		this.useScreenSpaceSampling = createVariantValue( this, options.useScreenSpaceSampling ?? true, normalizeBool );
		this.useLinearThickness = createVariantValue( this, options.useLinearThickness ?? true, normalizeBool );
		this.linearThicknessScale = uniform( options.linearThicknessScale ?? 100, 'float' );
		this.maxThickness = uniform( options.maxThickness ?? 0.35, 'float' );
		this.sectorMeasure = createVariantValue( this, options.sectorMeasure ?? GTVBAO_SECTOR_MEASURE_OPTIONS.Cosine, normalizeGtvbaoSectorMeasure );
		this.usePerspectiveCorrectSlice = createVariantValue( this, options.usePerspectiveCorrectSlice ?? true, normalizeBool );
		this.useDepthMips = createVariantValue( this, options.useDepthMips ?? true, normalizeBool );
		this.debugMode = createVariantValue(
			this,
			options.debugMode ?? 0,
			normalizeInt( GTVBAO_VARIANT_LIMITS.debugMode ),
			{
				shouldRebuild: ( previousValue, nextValue ) => getGtvbaoDebugVariantKey( previousValue ) !== getGtvbaoDebugVariantKey( nextValue ),
				shouldNotify: ( previousValue, nextValue ) => isGtvbaoDebugEnabled( previousValue ) !== isGtvbaoDebugEnabled( nextValue ) || getGtvbaoDebugVariantKey( previousValue ) !== getGtvbaoDebugVariantKey( nextValue )
			}
		);
		this.useTemporalFiltering = options.useTemporalFiltering ?? true;
		this.resolutionScale = options.resolutionScale ?? 1;
		// Consumers built through createDepthAwareAo upsample the reduced-resolution
		// AO by depth; the uniform gates it per frame, since it needs the linear-depth
		// MIPs and does nothing useful at full resolution.
		this.useDepthAwareUpsample = options.useDepthAwareUpsample ?? true;
		this._upsampleEnabled = uniform( 0 );
		this._onVariantChange = null;
		this._variantBatchDepth = 0;
		this._batchedVariantNotify = false;
		this._batchedVariantRebuild = false;
		this._resolution = uniform( new Vector2() );
		this._halfProjScale = uniform( 1 );
		this._temporalDirection = uniform( 0 );
		this._temporalOffset = uniform( 0 );
		this._cameraProjectionMatrixInverse = uniform( camera.projectionMatrixInverse );
		this._cameraNear = reference( 'near', 'float', camera );
		this._cameraFar = reference( 'far', 'float', camera );
		this._camera = camera;
		this._isOrthographicCamera = camera.isOrthographicCamera === true;
		this._depthPrefilter = new GTVBAODepthPrefilter( this.depthNode, this._cameraNear, this._cameraFar, this.maxThickness, this._isOrthographicCamera );
		this._aoRenderTarget = createGtvbaoRenderTarget( GTVBAO_PASS_NAMES.ao, RedFormat );
		this._debugRenderTarget = createGtvbaoRenderTarget( GTVBAO_PASS_NAMES.debug, RGBAFormat );
		this._material = new NodeMaterial();
		this._material.name = GTVBAO_PASS_NAMES.ao;
		this._fragmentContext = null;
		this._logarithmicDepthBuffer = false;
		// The AO target uses LinearFilter, so consumers sampling at full resolution get
		// hardware bilinear upsampling for free when resolutionScale < 1. Note that
		// GTVBAODenoiseNode sizes itself from this texture, so denoising intentionally
		// runs at AO resolution (its radius is in AO texels) before the bilinear upscale.
		this._textureNode = passTexture( this, this._aoRenderTarget.texture );
		this._lastSize = { aoWidth: 0, aoHeight: 0, projectionScale: - 1, targetIsDebug: null };
	}
	setVariantChangeCallback( callback ) {
		this._onVariantChange = callback;
	}
	batchVariantChanges( callback ) {
		this._variantBatchDepth ++;
		try {
			return callback();
		} finally {
			this._variantBatchDepth --;
			if ( this._variantBatchDepth === 0 && this._batchedVariantNotify ) {
				const rebuild = this._batchedVariantRebuild;
				this._batchedVariantNotify = false;
				this._batchedVariantRebuild = false;
				this._markVariantDirty( rebuild );
			}
		}
	}
	_markVariantDirty( rebuildMaterial = true ) {
		if ( this._variantBatchDepth > 0 ) {
			this._batchedVariantNotify = true;
			this._batchedVariantRebuild ||= rebuildMaterial;
			return;
		}
		if ( rebuildMaterial ) {
			this.needsUpdate = true;
			if ( this._material !== undefined ) this._refreshMaterialFragmentNode();
		}
		if ( this._onVariantChange !== null ) this._onVariantChange();
	}
	_refreshMaterialFragmentNode() {
		if ( this._fragmentContext === null ) {
			this._material.needsUpdate = true;
			return;
		}
		this._material.fragmentNode = createGtvbaoFragmentNode( this, this._logarithmicDepthBuffer, this._fragmentContext );
		this._material.needsUpdate = true;
	}
	_getActiveRenderTarget() {
		return isGtvbaoDebugEnabled( this.debugMode.value ) ? this._debugRenderTarget : this._aoRenderTarget;
	}
	getTextureNode() {
		return this._textureNode;
	}
	// Linear-depth MIP chain at AO resolution; level 0 doubles as the depth
	// source for GTVBAODenoiseNode. Only refreshed while useDepthMips is on.
	getDepthMipNodes() {
		return this._depthPrefilter.mipTextureNodes;
	}
	/** The AO texture read at a lit fragment, upsampled by depth while enabled. */
	createDepthAwareAo( aoTexture, fragment ) {
		return createGtvbaoDepthAwareAo( this, aoTexture, fragment );
	}
	/** The same for a full-screen quad, reconstructing the fragment from the pre-pass buffers. */
	createDepthAwareAoFromBuffers( aoTexture, depthTexture, normalTexture, screenUv ) {
		return createGtvbaoDepthAwareAoFromBuffers( this, aoTexture, depthTexture, normalTexture, screenUv );
	}
	isDepthAwareUpsampleActive() {
		return this.useDepthAwareUpsample && this.useDepthMips.value && this.resolutionScale < 1;
	}
	setSize( width, height ) {
		const renderTarget = this._getActiveRenderTarget();
		const targetIsDebug = renderTarget === this._debugRenderTarget;
		const aoWidth = Math.max( 1, Math.round( width * this.resolutionScale ) );
		const aoHeight = Math.max( 1, Math.round( height * this.resolutionScale ) );
		this._depthPrefilter.setSize( aoWidth, aoHeight, width, height );
		const projectionScale = this._camera.projectionMatrix.elements[ 5 ];
		const last = this._lastSize;
		if (
			last.aoWidth === aoWidth &&
			last.aoHeight === aoHeight &&
			last.projectionScale === projectionScale &&
			last.targetIsDebug === targetIsDebug
		) return;
		last.aoWidth = aoWidth;
		last.aoHeight = aoHeight;
		last.projectionScale = projectionScale;
		last.targetIsDebug = targetIsDebug;
		this._resolution.value.set( aoWidth, aoHeight );
		renderTarget.setSize( aoWidth, aoHeight );
		const inactiveRenderTarget = targetIsDebug ? this._aoRenderTarget : this._debugRenderTarget;
		if ( inactiveRenderTarget.width !== 1 || inactiveRenderTarget.height !== 1 ) inactiveRenderTarget.setSize( 1, 1 );
		this._halfProjScale.value = aoHeight * projectionScale * 0.25;
	}
	updateBefore( frame ) {
		const { renderer } = frame;
		_rendererState = RendererUtils.resetRendererState( renderer, _rendererState );
		const size = renderer.getDrawingBufferSize( _size );
		this.setSize( size.width, size.height );
		if ( this.useTemporalFiltering === true ) {
			const frameId = frame.frameId;
			this._temporalDirection.value = _temporalRotations[ frameId % 6 ] / 360;
			this._temporalOffset.value = _spatialOffsets[ frameId % 4 ];
		} else {
			this._temporalDirection.value = 1;
			this._temporalOffset.value = 1;
		}
		if ( this.useDepthMips.value ) this._depthPrefilter.compute( renderer );
		this._upsampleEnabled.value = this.isDepthAwareUpsampleActive() ? 1 : 0;
		_quadMesh.material = this._material;
		const renderTarget = this._getActiveRenderTarget();
		_quadMesh.name = renderTarget === this._debugRenderTarget ? GTVBAO_PASS_NAMES.debug : GTVBAO_PASS_NAMES.ao;
		renderer.setRenderTarget( renderTarget );
		// resetRendererState() enables autoClear, so the quad pass itself clears the
		// target via loadOp; an explicit renderer.clear() would cost an extra render pass.
		// Background pixels are discarded and keep this white (unoccluded) clear.
		renderer.setClearColor( 0xffffff, 1 );
		_quadMesh.render( renderer );
		this._textureNode.value = renderTarget.texture;
		RendererUtils.restoreRendererState( renderer, _rendererState );
	}
	setup( builder ) {
		this._logarithmicDepthBuffer = builder.renderer.logarithmicDepthBuffer === true && ! this._isOrthographicCamera;
		this._depthPrefilter.setLogarithmicDepthBuffer( this._logarithmicDepthBuffer );
		this._fragmentContext = builder.getSharedContext();
		this._refreshMaterialFragmentNode();
		return this._textureNode;
	}
	dispose() {
		this._depthPrefilter.dispose();
		this._aoRenderTarget.dispose();
		this._debugRenderTarget.dispose();
		this._material.dispose();
	}
}
export default GTVBAONode;
export const gtvbao = ( depthNode, normalNode, camera, options ) => new GTVBAONode( depthNode, normalNode, camera, options );
export { GTVBAO_DEBUG_MODE_OPTIONS, GTVBAO_VARIANT_LIMITS, getGtvbaoDebugVariantKey, isGtvbaoDebugEnabled, isGtvbaoTemporalJitterDebug } from './GTVBAODebugModes.js';
export { GTVBAO_SECTOR_MEASURE_OPTIONS } from './GTVBAOSectorMeasure.js';
