import { Box3, BufferAttribute, BufferGeometry, Euler, MathUtils, Matrix4, Mesh, MeshStandardMaterial, Scene, Vector3 } from "three";
const defined = require("./defined");
const { mergeGeometries } = require("./Utils");
const { buildTextureAtlas } = require("./textureAtlas");

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
//空间切分参数：单个瓦片最少三角形数与最大递归深度，防止过度切分
const MIN_TRIANGLES_PER_TILE = 2048;
const MAX_SPLIT_DEPTH = 10;

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

    //纹理图集优化：合并"仅贴图不同"的材质，减少后续瓦片的图元数
    if (options.textureAtlas) {
        console.time('textureAtlas');
        const stats = await buildTextureAtlas(scene);
        console.log('纹理图集统计:', JSON.stringify(stats));
        console.timeEnd('textureAtlas');
    }

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
    //先按材质合并网格，再按空间递归切分为瓦片：空间聚集的瓦片才能被视锥剔除按需渲染
    const items = [];
    materialMeshes.forEach((meshes, material) => {
        if (options.merge) {
            items.push(makeItem(mergeMeshes(meshes, material), material));
        } else {
            meshes.forEach(mesh => items.push(makeItem(mesh, material)));
        }
    });
    let buckets;
    if (options.spatialSplit !== false) {
        buckets = splitSpatially(items, 0);
    } else {
        //关闭空间拆分：按材质顺序装填瓦片，不做几何切分（适合单体小模型）
        buckets = [[]];
        let bucketBytes = 0;
        items.forEach(item => {
            if (bucketBytes + item.byteLength >= tileExpectSize && buckets[buckets.length - 1].length > 0) {
                buckets.push([]);
                bucketBytes = 0;
            }
            buckets[buckets.length - 1].push(item);
            bucketBytes += item.byteLength;
        });
        buckets = buckets.filter(bucket => bucket.length > 0);
    }
    buckets.forEach(bucketItems => {
        const tile = makeTile();
        bucketItems.forEach(item => {
            if (options.merge)
                addFeatureIds(tile, item.mesh);
            addTileNode(tile, item.mesh);
            tile.byteLength += item.byteLength;
            tile.vertexesCount += getVertexesCount(item.mesh.geometry);
            tile.trianglesCount += getTrianglesCount(item.mesh.geometry);
        });
        pushTile(tile);
    });

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

    //构造切分项（mesh + 字节长度，并预计算包围盒供切分使用）
    function makeItem(mesh, material) {
        if (!mesh.geometry.boundingBox)
            mesh.geometry.computeBoundingBox();
        return { mesh, material, byteLength: computeGeometryByteLength(mesh.geometry) };
    };

    /**
     * 按空间递归切分网格集合，返回空间聚集的网格桶列表。
     * 每次取整体包围盒最长轴，以三角形质心中位数为切分面（两侧三角形数均衡）；
     * 完全落在一侧的网格整体归属，跨面的网格切分几何（仅merge模式，否则按中心归属）。
     * @param {object[]} items
     * @param {number} depth
     * @returns {Array<object[]>}
    */
    function splitSpatially(items, depth) {
        const totalBytes = items.reduce((sum, item) => sum + item.byteLength, 0);
        const totalTriangles = items.reduce((sum, item) => sum + getTrianglesCount(item.mesh.geometry), 0);
        if (totalBytes <= tileExpectSize || totalTriangles < MIN_TRIANGLES_PER_TILE || depth >= MAX_SPLIT_DEPTH)
            return [items];
        const bucketBox = new Box3();
        items.forEach(item => bucketBox.union(item.mesh.geometry.boundingBox));
        const size = bucketBox.getSize(new Vector3());
        const axis = size.x >= size.y && size.x >= size.z ? 0 : (size.y >= size.z ? 1 : 2);
        if (size.getComponent(axis) <= 0)
            return [items];
        //所有三角形质心在指定轴上的分量，取中位数作为切分面位置
        const centers = [];
        items.forEach(item => collectTriangleCenters(item.mesh.geometry, axis, centers));
        centers.sort((a, b) => a - b);
        const splitValue = centers[Math.floor(centers.length / 2)];
        const left = [], right = [];
        items.forEach(item => {
            const box = item.mesh.geometry.boundingBox;
            if (box.max.getComponent(axis) <= splitValue) {
                left.push(item);
            } else if (box.min.getComponent(axis) >= splitValue) {
                right.push(item);
            } else if (options.merge) {
                splitItemByAxis(item, axis, splitValue, left, right);
            } else {
                (box.getCenter(new Vector3()).getComponent(axis) < splitValue ? left : right).push(item);
            }
        });
        //某一侧为空说明质心重合等退化情况，无法继续推进
        if (left.length === 0 || right.length === 0)
            return [items];
        return splitSpatially(left, depth + 1).concat(splitSpatially(right, depth + 1));
    };

    //收集几何体所有三角形质心在指定轴上的分量
    function collectTriangleCenters(geometry, axis, centers) {
        const position = geometry.attributes.position;
        const index = geometry.index;
        const count = index ? index.count : position.count;
        for (let i = 0; i < count; i += 3) {
            const a = index ? index.getX(i) : i;
            const b = index ? index.getX(i + 1) : i + 1;
            const c = index ? index.getX(i + 2) : i + 2;
            centers.push((position.getComponent(a, axis) + position.getComponent(b, axis) + position.getComponent(c, axis)) / 3);
        }
    };

    /**
     * 将跨切分面的网格沿切分面切分为两个子网格，按三角形质心归属两侧。
     * 按原始三角形顺序稳定划分，保证每个构件段（segment）在同一侧内保持连续，
     * 从而featureId分段信息可按段内三角形数重建。
     * @param {object} item
     * @param {number} axis
     * @param {number} splitValue
     * @param {object[]} left
     * @param {object[]} right
    */
    function splitItemByAxis(item, axis, splitValue, left, right) {
        let geometry = item.mesh.geometry;
        let segments = item.mesh.userData.segments;
        //单几何体材质可能保留索引：转非索引并同步重建segments顶点数
        if (defined(geometry.index)) {
            geometry = geometry.toNonIndexed();
            if (segments && segments.length === 1)
                segments = [{ name: segments[0].name, vertexCount: geometry.attributes.position.count }];
        }
        const position = geometry.attributes.position;
        const triangleCount = position.count / 3;
        //标记每个三角形的归属（1=左 2=右）
        const flags = new Uint8Array(triangleCount);
        let leftTriangles = 0, rightTriangles = 0;
        for (let t = 0; t < triangleCount; t++) {
            const v = t * 3;
            const center = (position.getComponent(v, axis) + position.getComponent(v + 1, axis) + position.getComponent(v + 2, axis)) / 3;
            const flag = center < splitValue ? 1 : 2;
            flags[t] = flag;
            if (flag === 1) leftTriangles++; else rightTriangles++;
        }
        if (leftTriangles === 0 || rightTriangles === 0) {
            //切分面恰好落在网格内但质心全在一侧：整件归属多数侧
            (leftTriangles > 0 ? left : right).push(item);
            return;
        }
        const parts = [
            { flag: 1, triangles: leftTriangles, list: left },
            { flag: 2, triangles: rightTriangles, list: right },
        ];
        parts.forEach(part => {
            const subGeometry = new BufferGeometry();
            for (const name in geometry.attributes) {
                const attribute = geometry.attributes[name];
                const itemSize = attribute.itemSize;
                const source = attribute.array;
                const target = new source.constructor(part.triangles * 3 * itemSize);
                let write = 0;
                for (let t = 0; t < triangleCount; t++) {
                    if (flags[t] !== part.flag)
                        continue;
                    const start = t * 3 * itemSize;
                    target.set(source.subarray(start, start + 3 * itemSize), write);
                    write += 3 * itemSize;
                }
                subGeometry.setAttribute(name, new BufferAttribute(target, itemSize, attribute.normalized));
            }
            subGeometry.computeBoundingBox();
            //按原段顺序重建segments：稳定划分下每段在同一侧的三角形保持连续
            const subSegments = [];
            let cursor = 0;
            (segments || []).forEach(segment => {
                const segmentTriangles = Math.floor(segment.vertexCount / 3);
                let count = 0;
                for (let t = cursor; t < cursor + segmentTriangles; t++) {
                    if (flags[t] === part.flag)
                        count++;
                }
                if (count > 0)
                    subSegments.push({ name: segment.name, vertexCount: count * 3 });
                cursor += segmentTriangles;
            });
            const subMesh = new Mesh(subGeometry, item.material);
            if (subSegments.length > 0)
                subMesh.userData.segments = subSegments;
            part.list.push(makeItem(subMesh, item.material));
        });
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

