import { Box3, BufferAttribute, BufferGeometry, Euler, MathUtils, Matrix4, Mesh, MeshStandardMaterial, Scene, Vector3 } from "three";
const defined = require("./defined");
const { mergeGeometries } = require("./Utils");

/**
 * @import { Material } from "three";
*/

/**
 * 转换前后对应的材质对象
 * @type {Map<Material, MeshStandardMaterial>}
*/
const convertedMaterials = new Map();
/**
 * 材质对应的Mesh对象
 * @type {Map<Material, Array<Mesh>>}
*/
const materialMeshes = new Map();
/**
 * 单位矩阵
 * @type {Matrix4}
*/
const identityMatrix = new Matrix4().identity();

class Tile {
    constructor() {
        this.scene = new Scene();
        this.byteLength = 0;
        this.vertexesCount = 0;
        this.trianglesCount = 0;
        this.mergedMesh = null;
        this.features = []; //构件名称列表，与瓦片内featureId一一对应
    }
    get name() {
        return this.scene.name;
    }
};

/**
 * 处理threejs场景模型并拆分为瓦片模型
 * @param {Scene} scene 
 * @param {object} options 
 * @returns {Promise<Array<Tile>>}
 */
async function processScene(scene, options) {
    console.time('processScene');

    /**
     * 旋转变换矩阵
     * @type {Matrix4|undefined}
    */
    let rotationTransform;
    if (options.rotation) {
        const euler = new Euler(MathUtils.degToRad(options.rotation.x), MathUtils.degToRad(options.rotation.y), MathUtils.degToRad(options.rotation.z));
        rotationTransform = new Matrix4().makeRotationFromEuler(euler);
    }

    //移除灯光和相机
    const children = scene.children.slice();
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.isLight)
            scene.remove(child);
        else if (child.isCamera)
            scene.remove(child);
    }
    children.length = 0;

    /**
     * 锚点修正变换矩阵（平移模型包围盒中心至原点）
     * @type {Matrix4|undefined}
    */
    let anchorTransform;
    if (options.correctCenter) {
        const boundingBox = new Box3().setFromObject(scene);
        const center = boundingBox.getCenter(new Vector3());
        anchorTransform = new Matrix4().makeTranslation(-center.x, -center.y, -center.z);
        console.log('模型锚点修正：包围盒中心', center, '已平移至原点。');
    }

    /**
     * @param {Mesh} mesh
     */
    function ensureStandardMaterial(mesh) {
        const material = mesh.material;
        //转换材质为MeshStandardMaterial
        let convertedMaterial;
        if (convertedMaterials.has(material)) {
            convertedMaterial = convertedMaterials.get(material);
        } else {
            convertedMaterial = convertToStandardMaterial(material);
            convertedMaterials.set(material, convertedMaterial);
        }
        mesh.material = convertedMaterial;
        if (!materialMeshes.has(convertedMaterial)) {
            materialMeshes.set(convertedMaterial, []);
        }
        //记录材质对应的网格
        materialMeshes.get(convertedMaterial).push(mesh);
    };

    //转换材质为MeshStandardMaterial，并记录材质对应的Mesh对象
    scene.traverse(element => {
        if (element.isMesh) {
            element.updateMatrixWorld();
            if (Array.isArray(element.material)) {
                const subMeshes = splitMesh(element);
                subMeshes.forEach(mesh => {
                    ensureStandardMaterial(mesh);
                });
                for (let i = 0; i < element.material.length; i++) {
                    element.material[i] = convertedMaterials.get(element.material[i]);
                }
            } else {
                ensureStandardMaterial(element);
            }
        }
    });

    const tileExpectSize = (options.tileSize ?? 10) * 1024 * 1024;
    const tiles = [];
    let tileNumber = 0;
    let tile = makeTile();
    //按照材质拆分场景
    materialMeshes.forEach((meshes, material) => {
        const mergedMesh = mergeMeshes(meshes, material);
        const geometryByteLength = computeGeometryByteLength(mergedMesh.geometry);
        const materialByteLength = 0;//computeMaterialByteLength(material);
        if (geometryByteLength + materialByteLength >= tileExpectSize && tile.byteLength > 0) {
            pushTile(tile);
            tile = makeTile();
        }

        if (options.merge) {
            addFeatureIds(tile, mergedMesh);
            addTileNode(tile, mergedMesh);
            tile.byteLength += geometryByteLength;
            tile.vertexesCount += getVertexesCount(mergedMesh.geometry);
            tile.trianglesCount += getTrianglesCount(mergedMesh.geometry);
        } else {
            meshes.forEach(mesh => {
                addTileNode(tile, mesh);
                tile.byteLength += computeGeometryByteLength(mesh.geometry);
                tile.vertexesCount += getVertexesCount(mesh.geometry);
                tile.trianglesCount += getTrianglesCount(mesh.geometry);
            });
        }
        // tile.byteLength += materialByteLength;
        tile.mergedMesh = mergedMesh;

        if (tile.byteLength >= tileExpectSize) {
            pushTile(tile);
            tile = makeTile();
        }
    });
    if (tile.byteLength > 0)
        pushTile(tile);

    console.timeEnd('processScene');
    return tiles;

    function makeTile() {
        const tile = new Tile();
        tile.scene.name = "Tile-" + tileNumber;
        tileNumber++;
        return tile;
    }

    function pushTile(tile) {
        if (!tiles.includes(tile))
            tiles.push(tile);
    }

    //注入瓦片局部featureId（构件粒度），供加载端通过EXT_mesh_features按构件拾取
    function addFeatureIds(tile, mergedMesh) {
        const segments = mergedMesh.userData.segments;
        if (!defined(segments) || segments.length === 0)
            return;
        const ids = new Uint32Array(mergedMesh.geometry.attributes.position.count);
        let offset = 0;
        segments.forEach(segment => {
            ids.fill(tile.features.length, offset, offset + segment.vertexCount);
            tile.features.push(segment.name);
            offset += segment.vertexCount;
        });
        mergedMesh.geometry.setAttribute('FEATURE_ID_0', new BufferAttribute(ids, 1));
    };

    function addTileNode(tile, node) {
        node.traverse(element => {
            element.updateMatrixWorld();
            if (element.geometry) {
                // 非合并几何体，为避免因geometry重用导致的重复应用世界矩阵，先克隆几何体
                const geometry = element.geometry.isMerged ? element.geometry : element.geometry.clone();
                // 应用世界矩阵
                !identityMatrix.equals(element.matrixWorld) && geometry.applyMatrix4(element.matrixWorld);
                // 应用锚点修正矩阵
                anchorTransform && geometry.applyMatrix4(anchorTransform);
                // 应用旋转变换矩阵
                rotationTransform && geometry.applyMatrix4(rotationTransform);
                element.geometry = geometry;
            }
        });
        node.traverse(element => {
            // 重置节点位置、旋转和缩放
            if (!identityMatrix.equals(element.matrix)) {
                identityMatrix.decompose(element.position, element.quaternion, element.scale);
                element.updateMatrix();
            }
        });
        tile.scene.add(node);
    }
};
/**
 * 将材质转换为MeshStandardMaterial
 * @param {Material} material
 * @returns {MeshStandardMaterial}
 */
function convertToStandardMaterial(material) {
    // 如果已经是MeshStandardMaterial，直接返回
    if (material.isMeshStandardMaterial) {
        return material;
    }

    // 创建新的MeshStandardMaterial
    const standardMaterial = new MeshStandardMaterial();

    // 复制基本属性
    standardMaterial.name = material.name;
    standardMaterial.opacity = material.opacity;
    standardMaterial.transparent = material.transparent;
    standardMaterial.side = material.side;
    standardMaterial.userData = material.userData;
    standardMaterial.vertexColors = material.vertexColors;

    if (defined(material.flatShading))
        standardMaterial.flatShading = material.flatShading;
    if (defined(material.color))
        standardMaterial.color.copy(material.color);
    if (defined(material.map))
        standardMaterial.map = material.map;
    if (defined(material.emissive))
        standardMaterial.emissive.copy(material.emissive);
    if (defined(material.emissiveIntensity))
        standardMaterial.emissiveIntensity = material.emissiveIntensity;
    if (defined(material.emissiveMap))
        standardMaterial.emissiveMap = material.emissiveMap;
    if (defined(material.alphaMap))
        standardMaterial.alphaMap = material.alphaMap;
    if (defined(material.aoMap))
        standardMaterial.aoMap = material.aoMap;
    if (defined(material.aoMapIntensity))
        standardMaterial.aoMapIntensity = material.aoMapIntensity;
    if (defined(material.bumpMap))
        standardMaterial.bumpMap = material.bumpMap;
    if (defined(material.bumpScale))
        standardMaterial.bumpScale = material.bumpScale;
    if (defined(material.displacementMap))
        standardMaterial.displacementMap = material.displacementMap;
    if (defined(material.displacementBias))
        standardMaterial.displacementBias = material.displacementBias;
    if (defined(material.displacementScale))
        standardMaterial.displacementScale = material.displacementScale;
    if (defined(material.envMap))
        standardMaterial.envMap = material.envMap;
    if (defined(material.envMapRotation))
        standardMaterial.envMapRotation.copy(material.envMapRotation);
    // if (defined(material.reflectivity))
    //     standardMaterial.reflectivity = material.reflectivity;
    // if (defined(material.refractionRatio))
    //     standardMaterial.refractionRatio = material.refractionRatio;
    if (defined(material.lightMap))
        standardMaterial.lightMap = material.lightMap;
    if (defined(material.lightMapIntensity))
        standardMaterial.lightMapIntensity = material.lightMapIntensity;
    if (defined(material.normalMap))
        standardMaterial.normalMap = material.normalMap;
    if (defined(material.normalMapType))
        standardMaterial.normalMapType = material.normalMapType;
    if (defined(material.normalScale))
        standardMaterial.normalScale.copy(material.normalScale);

    // 转换specular到metalness
    // Phong材质的specular颜色越亮，金属度越高
    if (defined(material.specular)) {
        const specularIntensity = (material.specular.r + material.specular.g + material.specular.b) / 3;
        standardMaterial.metalness = Math.min(specularIntensity, 1.0);
    } else {
        standardMaterial.metalness = 0.0;
    }
    // specular贴图，将specularMap作为metalnessMap使用
    if (defined(material.specularMap))
        standardMaterial.metalnessMap = material.specularMap;

    // 转换shininess到roughness
    // Phong材质的shininess越高，越光滑，roughness越低
    if (defined(material.shininess)) {
        // 将shininess (通常0-100) 转换为roughness (0-1)
        // 公式: roughness = 1 - (shininess / maxShininess)
        const maxShininess = 100;
        standardMaterial.roughness = Math.max(0.0, Math.min(1.0, 1.0 - (material.shininess / maxShininess)));
    } else {
        standardMaterial.roughness = 0.5; // 默认中等粗糙度
    }

    return standardMaterial;
};
/**
 * 将Mesh对象按照Group拆分为多个Mesh对象
 * @param {Mesh} mesh
 * @returns {Array<Mesh>}
 */
function splitMesh(mesh) {
    // 如果材质不是数组，直接返回原mesh
    if (!Array.isArray(mesh.material)) {
        return [mesh];
    }

    const groups = mesh.geometry.groups;
    if (!groups || groups.length === 0) {
        throw new Error('Mesh对象没有groups，无法拆分');
    }

    const result = [];
    let geometry = mesh.geometry;
    if (defined(geometry.index))
        geometry = geometry.toNonIndexed();
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const subMaterial = mesh.material[group.materialIndex];
        const subGeometry = new BufferGeometry();
        const start = group.start;
        const count = group.count;
        for (const name in geometry.attributes) {
            const attribute = geometry.attributes[name];
            const itemSize = attribute.itemSize;
            const array = attribute.array.subarray(start * itemSize, (start + count) * itemSize);
            subGeometry.setAttribute(name, new BufferAttribute(array, itemSize, attribute.normalized));
        }

        const subMesh = new Mesh(subGeometry, subMaterial);
        subMesh.name = mesh.name + '_subMesh_' + i;
        result.push(subMesh);
    }

    mesh.updateMatrixWorld();
    if (!identityMatrix.equals(mesh.matrixWorld)) {
        result.forEach(subMesh => {
            //将Mesh对象世界矩阵分解为拆分后子Mesh对象的位置、旋转和缩放
            mesh.matrixWorld.decompose(subMesh.position, subMesh.quaternion, subMesh.scale);
            subMesh.updateMatrix();
        });
    }
    return result;
};
/**
 * 合并同材质的Mesh对象
 * @param {Mesh[]} meshes
 * @param {Material} material
 * @returns {Mesh} userData.segments记录各源Mesh的名称与顶点数（已统一为非索引几何）
*/
function mergeMeshes(meshes, material) {
    const geometries = [];
    const segments = [];
    // 多几何体合并时normalizeGeometryAttributes会统一转非索引，这里提前转换保证segments顶点数一致；
    // 单几何体无需合并、保留索引，featureId填满整个数组即可
    const multiple = meshes.length > 1;
    meshes.forEach(mesh => {
        // 为避免因geometry重用导致的重复应用世界矩阵，先克隆几何体
        let geometry = mesh.geometry.clone();
        mesh.updateMatrixWorld();
        //将世界矩阵应用到几何体上
        !identityMatrix.equals(mesh.matrixWorld) && geometry.applyMatrix4(mesh.matrixWorld);
        if (multiple && defined(geometry.index))
            geometry = geometry.toNonIndexed();
        geometries.push(geometry);
        segments.push({ name: mesh.name, vertexCount: geometry.attributes.position.count });
    });
    //合并几何体
    const mergedGeometry = mergeGeometries(geometries, false);
    const mergedMesh = new Mesh(mergedGeometry, material);
    mergedMesh.userData.segments = segments;
    return mergedMesh;
};
/**
 * 计算材质的字节长度
 * @param {Material} material
 * @returns {number}
*/
function computeMaterialByteLength(material) {
    let byteLength = 0;
    for (const key in material) {
        const value = material[key];
        if (value && value.isTexture) {
            byteLength += value.image.data.size;
        }
    }
    return byteLength;
};
/**
 * 计算几何体的字节长度
 * @param {BufferGeometry} geometry
 * @returns {number}
*/
function computeGeometryByteLength(geometry) {
    let byteLength = 0;
    if (geometry.index) {
        byteLength += geometry.index.array.byteLength;
    }
    for (const name in geometry.attributes) {
        const attribute = geometry.attributes[name];
        byteLength += attribute.array.byteLength;
    }
    return byteLength;
};
/**
 * 获取几何体的顶点数量
 * @param {BufferGeometry} geometry
 * @returns {number}
*/
function getVertexesCount(geometry) {
    let vertexCount = 0;
    if (geometry.attributes.position) {
        vertexCount += geometry.attributes.position.count;
    }
    return vertexCount;
};
/**
 * 获取几何体的三角形数量
 * @param {BufferGeometry} geometry
 * @returns {number}
*/
function getTrianglesCount(geometry) {
    let triangleCount = 0;
    if (geometry.index) {
        triangleCount += geometry.index.count / 3;
    } else if (geometry.attributes.position) {
        triangleCount += geometry.attributes.position.count / 3;
    }
    return triangleCount;
};

module.exports = processScene;
module.exports.Tile = Tile;

