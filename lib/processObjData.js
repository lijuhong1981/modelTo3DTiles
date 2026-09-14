import { BufferAttribute, BufferGeometry, DoubleSide, FrontSide, Material, Mesh, MeshPhongMaterial, MeshStandardMaterial, Object3D, RepeatWrapping, Scene, Texture } from "three";
const defined = require("./defined");

/**
 * 纹理缓存
 * @type {Map<string, Texture>}
*/
const textureCache = new Map();
/**
 * 材质缓存
 * @type {Map<string, Material>}
*/
const materialsCache = new Map();

/**
 * 处理从loadObj加载进来的obj数据并转换为threejs场景对象
 * @param {object} objData
 * @param {object} options
 * @returns {Promise<Scene>}
 */
async function processObjData(objData, options) {
    console.time('processObjData');
    objData.materials.forEach(material => {
        processMaterial(material);
    });
    const meshesMap = {};
    objData.nodes.forEach(node => {
        const meshes = [];
        meshesMap[node.name] = meshes;
        node.meshes.forEach(mesh => {
            let count = 0;
            mesh.primitives.forEach(primitive => {
                const geometry = processPrimitive(primitive, options.computeVertexNormals);
                const material = materialsCache.get(primitive.material);
                if (!material) {
                    throw new Error('Material not found: ' + primitive.material);
                }
                const meshObj = new Mesh(geometry, material);
                meshObj.name = mesh.name + '_' + count++;
                meshes.push(meshObj);
            });
        });
    });
    const scene = new Scene();
    scene.name = objData.name;
    Object.keys(meshesMap).forEach(name => {
        const child = new Object3D();
        child.name = name;
        child.add(...meshesMap[name]);
        scene.add(child);
    });
    console.timeEnd('processObjData');
    return scene;
};
/**
 * 处理材质数据并转换为threejs材质对象
 * @param {object} materialData
 * @returns {Material}
*/
function processMaterial(materialData) {
    if (materialsCache.has(materialData.name))
        return materialsCache.get(materialData.name);
    let material;
    if (materialData.pbrMetallicRoughness) {
        const pbrMetallicRoughness = materialData.pbrMetallicRoughness;
        material = new MeshStandardMaterial();
        if (pbrMetallicRoughness.baseColorFactor) {
            material.color.setRGB(pbrMetallicRoughness.baseColorFactor[0], pbrMetallicRoughness.baseColorFactor[1], pbrMetallicRoughness.baseColorFactor[2]);
            material.opacity = pbrMetallicRoughness.baseColorFactor[3];
        }
        if (defined(pbrMetallicRoughness.baseColorTexture)) {
            material.map = processTexture(pbrMetallicRoughness.baseColorTexture);
        }
        if (defined(pbrMetallicRoughness.metallicFactor)) {
            material.metalness = pbrMetallicRoughness.metallicFactor;
        }
        if (defined(pbrMetallicRoughness.roughnessFactor)) {
            let roughnessFactor = pbrMetallicRoughness.roughnessFactor;
            while (roughnessFactor > 1) {
                roughnessFactor = roughnessFactor / 10;
            }
            material.roughness = roughnessFactor;
        }
    } else if (materialData.extensions && materialData.extensions.KHR_materials_pbrSpecularGlossiness) {
        material = new MeshPhongMaterial();
        const pbrSpecularGlossiness = materialData.extensions.KHR_materials_pbrSpecularGlossiness;
        if (defined(pbrSpecularGlossiness.diffuseFactor)) {
            material.color.setRGB(pbrSpecularGlossiness.diffuseFactor[0], pbrSpecularGlossiness.diffuseFactor[1], pbrSpecularGlossiness.diffuseFactor[2]);
            material.opacity = pbrSpecularGlossiness.diffuseFactor[3];
        }
        if (defined(pbrSpecularGlossiness.diffuseTexture)) {
            material.map = processTexture(pbrSpecularGlossiness.diffuseTexture);
        }
        if (defined(pbrSpecularGlossiness.specularFactor)) {
            material.specular.setRGB(pbrSpecularGlossiness.specularFactor[0], pbrSpecularGlossiness.specularFactor[1], pbrSpecularGlossiness.specularFactor[2]);
        }
        if (defined(pbrSpecularGlossiness.specularGlossinessTexture)) {
            material.specularMap = processTexture(pbrSpecularGlossiness.specularGlossinessTexture);
        }
        if (defined(pbrSpecularGlossiness.glossinessFactor)) {
            material.shininess = pbrSpecularGlossiness.glossinessFactor;
        }
    } else {
        throw new Error('Unsupported material type: ' + JSON.stringify(materialData));
    }
    material.name = materialData.name;
    if (defined(materialData.alphaMode)) {
        material.transparent = (materialData.alphaMode === 'BLEND');
    }
    if (defined(materialData.doubleSided)) {
        material.side = materialData.doubleSided ? DoubleSide : FrontSide;
    }
    if (defined(materialData.emissiveFactor)) {
        material.emissive.setRGB(materialData.emissiveFactor[0], materialData.emissiveFactor[1], materialData.emissiveFactor[2]);
    }
    if (defined(materialData.emissiveTexture)) {
        material.emissiveMap = processTexture(materialData.emissiveTexture);
    }
    if (defined(materialData.normalTexture)) {
        material.normalMap = processTexture(materialData.normalTexture);
    }
    if (defined(materialData.occlusionTexture)) {
        material.aoMap = processTexture(materialData.occlusionTexture);
    }
    // console.log('processMaterial:', materialData, material)
    materialsCache.set(materialData.name, material);
    return material;
};
/**
 * 处理纹理数据并转换为threejs纹理对象
 * @param {object} textureData
 * @returns {Texture}
*/
function processTexture(textureData) {
    if (textureCache.has(textureData.name))
        return textureCache.get(textureData.name);
    let extension = textureData.extension;
    extension = extension.substring(extension.indexOf('.') + 1).toLowerCase();
    let type;
    switch (extension) {
        case 'png':
            type = 'image/png';
            break;
        case 'jpg':
        case 'jpeg':
        default:
            type = 'image/jpeg';
            break;
    }
    const image = {
        name: textureData.name,
        data: new Blob([textureData.source.buffer], { type: type }),
        mimeType: type,
    };
    const texture = new Texture(image);
    texture.name = textureData.name;
    texture.wrapS = texture.wrapT = RepeatWrapping;
    // texture.colorSpace = SRGBColorSpace;
    texture.userData.mimeType = type;
    textureCache.set(textureData.name, texture);
    return texture;
};
/**
 * 处理图元数据并转换为threejs几何体对象
 * @param {object} primitive
 * @param {boolean} needsComputeVertexNormals
 * @returns {BufferGeometry}
*/
function processPrimitive(primitive, needsComputeVertexNormals) {
    const geometry = new BufferGeometry();
    // if (primitive.positions)
    const positions = primitive.positions.typedArray.subarray(0, primitive.positions.length);
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const vertexCount = geometry.attributes.position.count;
    // if (primitive.uvs)
    const uvs = primitive.uvs.typedArray.subarray(0, primitive.uvs.length);
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    let hasNormals = false;
    if (primitive.normals.length > 0) {
        const normals = primitive.normals.typedArray.subarray(0, primitive.normals.length);
        geometry.setAttribute('normal', new BufferAttribute(normals, 3));
        hasNormals = true;
    }
    if (primitive.indices.length > 0) {
        let indices = primitive.indices.typedArray.subarray(0, primitive.indices.length);
        // 顶点数量小于 65535 时，将 indices 转换为 UInt16Array类型
        vertexCount < 65535 && (indices = new Uint16Array(indices));
        geometry.setIndex(new BufferAttribute(indices, 1));
    }
    if (needsComputeVertexNormals && hasNormals === false)
        geometry.computeVertexNormals();
    // geometry.computeBoundingBox();
    // geometry.computeBoundingSphere();
    return geometry;
};

module.exports = processObjData;

