const { Document, Material, Mesh, Texture, TextureInfo, Primitive, Scene, Node } = require('@gltf-transform/core');
import { BufferAttribute, BufferGeometry, ClampToEdgeWrapping, DoubleSide, FrontSide, LinearFilter, LinearMipmapLinearFilter, LinearMipmapNearestFilter, MeshStandardMaterial, MirroredRepeatWrapping, NearestFilter, NearestMipmapLinearFilter, NearestMipmapNearestFilter, Object3D, RepeatWrapping, Material as ThreeMaterial, Mesh as ThreeMesh, Scene as ThreeScene, Texture as ThreeTexture } from 'three';
const defined = require("./defined");

const imageCache = new Map();
const textureCache = new Map();
const materialCache = new Map();
const geometryCache = new Map();

const WEBGL_FILTERS = {
    9728: NearestFilter,
    9729: LinearFilter,
    9984: NearestMipmapNearestFilter,
    9985: LinearMipmapNearestFilter,
    9986: NearestMipmapLinearFilter,
    9987: LinearMipmapLinearFilter
};

const WEBGL_WRAPPINGS = {
    33071: ClampToEdgeWrapping,
    33648: MirroredRepeatWrapping,
    10497: RepeatWrapping
};

const ATTRIBUTES = {
    POSITION: 'position',
    NORMAL: 'normal',
    TANGENT: 'tangent',
    TEXCOORD_0: 'uv',
    TEXCOORD_1: 'uv1',
    TEXCOORD_2: 'uv2',
    TEXCOORD_3: 'uv3',
    COLOR_0: 'color',
    WEIGHTS_0: 'skinWeight',
    JOINTS_0: 'skinIndex',
};

/**
 * 处理GLTF文档，转换为threejs场景对象
 * @param {Document} gltfDoc
 * @param {object} options
 * @returns {ThreeScene}
 */
function processGltfDoc(gltfDoc, options) {
    console.time('processGltfData');
    const root = gltfDoc.getRoot();
    const scenes = root.listScenes();
    const list = [];
    scenes.forEach(scene => {
        list.push(processScene(scene));
    });
    const result = (list.length === 1 ? list[0] : new Scene());
    if (list.length !== 1) {
        result.name = root.getName();
        list.forEach(scene => {
            const children = scene.children.slice();
            children.forEach(child => {
                result.add(child);
            });
        });
    }
    console.timeEnd('processGltfData');
    return result;
}
/**
 * 处理图片数据，转换为threejs图片数据对象
 * @param {Texture} texture
 * @returns {object}
*/
function processImage(texture) {
    const name = texture.getName();
    if (textureCache.has(name)) {
        return textureCache.get(name);
    }
    const imageData = texture.getImage();
    // const extensions = texture.listExtensions();
    // const extras = texture.getExtras();
    const mimeType = texture.getMimeType();
    const data = new Blob([imageData.buffer], { type: mimeType });
    const result = {
        name,
        data,
        mimeType,
    };
    imageCache.set(name, result);
    return result;
};
/**
 * 处理纹理数据，转换为threejs纹理对象
 * @param {Texture} texture
 * @param {TextureInfo} textureInfo
 * @returns {ThreeTexture}
*/
function processTexture(texture, textureInfo) {
    const name = texture.getName();
    const minFilter = textureInfo.getMinFilter();
    const magFilter = textureInfo.getMagFilter();
    const wrapS = textureInfo.getWrapS();
    const wrapT = textureInfo.getWrapT();
    const key = `${name}-${minFilter}-${magFilter}-${wrapS}-${wrapT}`;
    if (textureCache.has(key)) {
        return textureCache.get(key);
    }
    const image = processImage(texture);
    const result = new ThreeTexture(image);
    result.name = name;
    result.flipY = false;
    result.minFilter = WEBGL_FILTERS[minFilter] || LinearMipmapLinearFilter;
    result.magFilter = WEBGL_FILTERS[magFilter] || LinearFilter;
    result.wrapS = WEBGL_WRAPPINGS[wrapS] || RepeatWrapping;
    result.wrapT = WEBGL_WRAPPINGS[wrapT] || RepeatWrapping;
    result.generateMipmaps = !result.isCompressedTexture && result.minFilter !== NearestFilter && result.minFilter !== LinearFilter;
    textureCache.set(key, result);
    return result;
};
/**
 * 处理材质数据，转换为threejs材质对象
 * @param {Material} material
 * @returns {ThreeMaterial}
*/
function processMaterial(material) {
    const name = material.getName();
    if (materialCache.has(name)) {
        return materialCache.get(name);
    }

    const result = new MeshStandardMaterial();
    result.name = name;
    const baseColorFactor = material.getBaseColorFactor();
    if (baseColorFactor) {
        result.color.setRGB(baseColorFactor[0], baseColorFactor[1], baseColorFactor[2]);
        result.opacity = baseColorFactor[3];
    }
    const baseColorTexture = material.getBaseColorTexture();
    if (baseColorTexture) {
        const baseColorTextureInfo = material.getBaseColorTextureInfo();
        result.map = processTexture(baseColorTexture, baseColorTextureInfo);
    }
    const emissiveFactor = material.getEmissiveFactor();
    if (emissiveFactor) {
        result.emissive.setRGB(emissiveFactor[0], emissiveFactor[1], emissiveFactor[2]);
    }
    const emissiveTexture = material.getEmissiveTexture();
    if (emissiveTexture) {
        const emissiveTextureInfo = material.getEmissiveTextureInfo();
        result.emissiveMap = processTexture(emissiveTexture, emissiveTextureInfo);
    }
    const normalTexture = material.getNormalTexture();
    if (normalTexture) {
        const normalTextureInfo = material.getNormalTextureInfo();
        result.normalMap = processTexture(normalTexture, normalTextureInfo);
    }
    const normalScale = material.getNormalScale();
    if (defined(normalScale)) {
        result.normalScale.set(normalScale, normalScale);
    }
    const occlusionTexture = material.getOcclusionTexture();
    if (occlusionTexture) {
        const occlusionTextureInfo = material.getOcclusionTextureInfo();
        result.aoMap = processTexture(occlusionTexture, occlusionTextureInfo);
    }
    const occlusionStrength = material.getOcclusionStrength();
    if (defined(occlusionStrength)) {
        result.aoMapIntensity = occlusionStrength;
    }
    const metallicFactor = material.getMetallicFactor();
    if (defined(metallicFactor)) {
        result.metalness = metallicFactor;
    }
    const roughnessFactor = material.getRoughnessFactor();
    if (defined(roughnessFactor)) {
        result.roughness = roughnessFactor;
    }
    const metallicRoughnessTexture = material.getMetallicRoughnessTexture();
    if (metallicRoughnessTexture) {
        const metallicRoughnessTextureInfo = material.getMetallicRoughnessTextureInfo();
        result.metalnessMap = processTexture(metallicRoughnessTexture, metallicRoughnessTextureInfo);
        result.roughnessMap = processTexture(metallicRoughnessTexture, metallicRoughnessTextureInfo);
    }
    const alphaMode = material.getAlphaMode();
    if (alphaMode === 'BLEND') {
        result.transparent = true;
        result.depthWrite = false;
    } else {
        result.transparent = false;
        if (alphaMode === 'MASK') {
            const alphaCutoff = material.getAlphaCutoff();
            result.alphaTest = defined(alphaCutoff) ? alphaCutoff : 0.5;
        }
    }
    const doubleSided = material.getDoubleSided();
    result.side = doubleSided ? DoubleSide : FrontSide;
    materialCache.set(name, result);
    return result;
};
/**
 * 处理图元数据，转换为threejs几何体对象
 * @param {Primitive} primitive
 * @returns {BufferGeometry}
*/
function processGeometry(primitive) {
    if (geometryCache.has(primitive)) {
        return geometryCache.get(primitive);
    }
    const result = new BufferGeometry();
    const indices = primitive.getIndices();
    if (indices) {
        const array = indices.getArray();
        result.setIndex(new BufferAttribute(array, 1));
    }
    const attributeNames = primitive.listSemantics();
    const attributes = primitive.listAttributes();
    for (let i = 0; i < attributeNames.length; i++) {
        const attributeName = attributeNames[i];
        const threeAttributeName = ATTRIBUTES[attributeName] || attributeName.toLowerCase();
        const attribute = attributes[i];
        const array = attribute.getArray();
        const itemSize = attribute.getElementSize();
        const normalized = attribute.getNormalized() === true;
        result.setAttribute(threeAttributeName, new BufferAttribute(array, itemSize, normalized));
    }
    geometryCache.set(primitive, result);
    return result;
}
/**
 * 处理图元数据，转换为threejs网格对象
 * @param {Primitive} primitive
 * @param {string} [fallbackName] 图元未命名时的回退名称（所属mesh/节点名）
 * @returns {ThreeMesh}
*/
function processPrimitive(primitive, fallbackName) {
    const name = primitive.getName() || fallbackName || '';
    const geometry = processGeometry(primitive);
    const material = processMaterial(primitive.getMaterial());
    const result = new ThreeMesh(geometry, material);
    result.name = name;
    return result;
};
/**
 * 处理网格数据，转换为threejs3D对象
 * @param {Mesh} mesh
 * @param {string} [ownerName] 所属节点名（mesh未命名时回退）
 * @returns {Object3D}
*/
function processMesh(mesh, ownerName) {
    const result = new Object3D();
    const name = mesh.getName() || ownerName;
    result.name = name;
    const primitives = mesh.listPrimitives();
    primitives.forEach(primitive => {
        result.add(processPrimitive(primitive, name));
    });
    return result;
};
/**
 * 处理节点数据，转换为threejs节点对象
 * @param {Node} node
 * @returns {Object3D}
*/
function processNode(node) {
    const result = new Object3D();
    const name = node.getName();
    result.name = name;
    const children = node.listChildren();
    children.forEach(childNode => {
        const child = processNode(childNode);
        result.add(child);
    });
    const mesh = node.getMesh();
    if (mesh) {
        const child = processMesh(mesh, node.getName());
        result.add(child);
    }
    return result;
};
/**
 * 处理场景数据，转换为threejs场景对象
 * @param {Scene} scene
 * @returns {ThreeScene}
*/
function processScene(scene) {
    const result = new ThreeScene();
    const name = scene.getName();
    result.name = name;
    const children = scene.listChildren();
    children.forEach(childNode => {
        const child = processNode(childNode);
        result.add(child);
    });
    return result;
};

module.exports = processGltfDoc;