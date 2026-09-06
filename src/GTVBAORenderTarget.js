import {
	ClampToEdgeWrapping,
	LinearFilter,
	RenderTarget,
	UnsignedByteType
} from 'three/webgpu';

export const createGtvbaoRenderTarget = ( name, format ) => {
	const renderTarget = new RenderTarget( 1, 1, { depthBuffer: false, format, type: UnsignedByteType } );
	renderTarget.texture.name = name;
	renderTarget.texture.generateMipmaps = false;
	renderTarget.texture.magFilter = LinearFilter;
	renderTarget.texture.minFilter = LinearFilter;
	renderTarget.texture.wrapS = ClampToEdgeWrapping;
	renderTarget.texture.wrapT = ClampToEdgeWrapping;
	return renderTarget;
};
