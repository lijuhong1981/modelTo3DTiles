import { Box3, BufferAttribute, BufferGeometry, Euler, MathUtils, Matrix4, Mesh, MeshStandardMaterial, Scene, Vector3 } from "three";
const defined = require("./defined");
const { mergeGeometries } = require("./Utils");
const { buildTextureAtlas, normalizeTexturePowers } = require("./textureAtlas");

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
        this.featureIndexes = new Map(); //构件名→featureId，同构件多图元归并为同一id
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
    } else if (options.resampleTextures) {
        //仅全量归一化非2的幂贴图（不做图集合并）
        console.time('resampleTextures');
        const stats = await normalizeTexturePowers(scene);
        console.log('贴图重采样统计:', JSON.stringify(stats));
        console.timeEnd('resampleTextures');
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

    //spatial切分依赖逐网格的空间归属与几何切分,实例化组展开回逐实例网格走现行路径
    if (options.split !== 'material')
        expandInstancedMeshes(scene);

    /**
     * 计算场景世界包围盒。实例化组代表网格位于原点(几何为局部坐标),
     * 不能用Box3.setFromObject,改用其userData.worldBounds参与并集。
     * @param {Scene} scene
     * @returns {Box3}
    */
    function computeSceneBounds(scene) {
        const box = new Box3();
        scene.updateMatrixWorld(true);
        const tmp = new Box3();
        scene.traverse(obj => {
            if (!obj.isMesh)
                return;
            if (obj.userData.isInstanced) {
                box.union(obj.userData.worldBounds);
                return;
            }
            if (!obj.geometry.boundingBox)
                obj.geometry.computeBoundingBox();
            box.union(tmp.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld));
        });
        return box;
    }

    /**
     * 锚点修正变换矩阵（平移模型包围盒中心至原点）
     * @type {Matrix4|undefined}
    */
    let anchorTransform;
    if (options.correctCenter) {
        const boundingBox = computeSceneBounds(scene);
        const center = boundingBox.getCenter(new Vector3());
        anchorTransform = new Matrix4().makeTranslation(-center.x, -center.y, -center.z);
        console.log('模型锚点修正：包围盒中心', center, '已平移至原点。');
        //实例化组的实例矩阵与组包围盒同步施加锚点(其几何不经matrixWorld烘焙)
        scene.traverse(obj => {
            if (obj.userData.isInstanced) {
                obj.userData.instances.forEach(instance => instance.matrix.premultiply(anchorTransform));
                obj.userData.worldBounds.applyMatrix4(anchorTransform);
            }
        });
    }
    //旋转变换对实例化组同样经premultiply同步(与展开路径"先锚点后旋转"的烘焙顺序一致)
    if (rotationTransform) {
        scene.traverse(obj => {
            if (obj.userData.isInstanced) {
                obj.userData.instances.forEach(instance => instance.matrix.premultiply(rotationTransform));
                obj.userData.worldBounds.applyMatrix4(rotationTransform);
            }
        });
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

    //转换材质为MeshStandardMaterial，并记录材质对应的Mesh对象；
    //实例化组代表网格不经材质合并(几何保持共享,由writeScene注入实例扩展)
    const instancedItems = [];
    scene.traverse(element => {
        if (element.isMesh) {
            element.updateMatrixWorld();
            if (element.userData.isInstanced) {
                instancedItems.push(element);
            } else if (Array.isArray(element.material)) {
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
    let tileNumber = 0;
    //先按材质合并网格，再按空间递归切分为LOD瓦片树：
    //每个内部节点也生成瓦片内容（该空间区域的按材质合并网格，图元更少），
    //加载端远景渲染粗层、近景refine细层，draw call随视距分层下降
    const items = [];
    //实例化组直接作为切分项:唯一几何一份+实例矩阵表,不克隆展开
    instancedItems.forEach(mesh => {
        if (!mesh.geometry.boundingBox)
            mesh.geometry.computeBoundingBox();
        const instanceBytes = mesh.userData.instances.length * (10 * 4 + 2);
        items.push({ mesh, material: mesh.material, byteLength: computeGeometryByteLength(mesh.geometry) + instanceBytes });
    });
    materialMeshes.forEach((meshes, material) => {
        if (options.mergePrimitive) {
            items.push(makeItem(mergeMeshes(meshes, material), material));
        } else {
            meshes.forEach(mesh => items.push(makeItem(mesh, material)));
        }
    });
    let root;
    if (options.split !== 'material') {
        root = buildTileNode(splitSpatially(items, 0), true);
    } else {
        //按材质顺序装填瓦片（不做几何切分，适合单体小模型），作为无内容的根节点
        const buckets = [[]];
        let bucketBytes = 0;
        items.forEach(item => {
            if (bucketBytes + item.byteLength >= tileExpectSize && buckets[buckets.length - 1].length > 0) {
                buckets.push([]);
                bucketBytes = 0;
            }
            buckets[buckets.length - 1].push(item);
            bucketBytes += item.byteLength;
        });
        root = {
            tile: null,
            children: buckets.filter(bucket => bucket.length > 0).map(bucket => buildTileNode({ items: bucket }, true)),
        };
    }

    console.timeEnd('processScene');
    return root;

    //由切分树节点生成瓦片树节点：所有节点（含中间层）均产出瓦片内容。
    //中间层配真实geometricError后支持逐分支渐进refine：近处分支下钻到叶子、远处分支停留在粗层，
    //draw call随镜头推进平滑阶梯变化而非整体跳变
    function buildTileNode(splitNode, isRoot) {
        const tile = makeTile();
        splitNode.items.forEach(item => {
            if (item.mesh.userData.isInstanced)
                addInstanceFeatureIds(tile, item.mesh);
            else if (options.mergePrimitive)
                addFeatureIds(tile, item.mesh);
            addTileNode(tile, item.mesh);
            tile.byteLength += item.byteLength;
            tile.vertexesCount += getVertexesCount(item.mesh.geometry);
            tile.trianglesCount += getTrianglesCount(item.mesh.geometry);
        });
        return {
            tile,
            children: (splitNode.children || []).map(child => buildTileNode(child, false)),
        };
    }

    function makeTile() {
        const tile = new Tile();
        tile.scene.name = "Tile-" + tileNumber;
        tileNumber++;
        return tile;
    }

    //注入瓦片局部featureId（构件粒度），供加载端通过EXT_mesh_features按构件拾取。
    //同一构件的多个图元（同节点多primitive、跨材质合并网格）归并为同一featureId，
    //否则按构件显隐/着色会漏掉该构件的其余图元
    function addFeatureIds(tile, mergedMesh) {
        const segments = mergedMesh.userData.segments;
        if (!defined(segments) || segments.length === 0)
            return;
        const ids = new Uint32Array(mergedMesh.geometry.attributes.position.count);
        let offset = 0;
        segments.forEach(segment => {
            let index = tile.featureIndexes.get(segment.name);
            if (index === undefined) {
                index = tile.features.length;
                tile.features.push(segment.name);
                tile.featureIndexes.set(segment.name, index);
            }
            ids.fill(index, offset, offset + segment.vertexCount);
            offset += segment.vertexCount;
        });
        mergedMesh.geometry.setAttribute('FEATURE_ID_0', new BufferAttribute(ids, 1));
    };

    //实例化组featureId登记:每实例(构件)一行,写入mesh.userData.instanceFeatureIds,
    //writeScene据此后处理注入EXT_instance_features的每实例_FEATURE_ID_0实例属性
    function addInstanceFeatureIds(tile, mesh) {
        const instances = mesh.userData.instances;
        const ids = new Array(instances.length);
        instances.forEach((instance, i) => {
            let index = tile.featureIndexes.get(instance.name);
            if (index === undefined) {
                index = tile.features.length;
                tile.features.push(instance.name);
                tile.featureIndexes.set(instance.name, index);
            }
            ids[i] = index;
        });
        mesh.userData.instanceFeatureIds = ids;
    };

    //构造切分项（mesh + 字节长度，并预计算包围盒供切分使用）
    function makeItem(mesh, material) {
        if (!mesh.geometry.boundingBox)
            mesh.geometry.computeBoundingBox();
        return { mesh, material, byteLength: computeGeometryByteLength(mesh.geometry) };
    };

    /**
     * 按空间递归切分网格集合，返回切分树：内部节点保留自身完整bucket供LOD粗层瓦片使用，
     * 子节点持有克隆/切分后的独立网格（父子瓦片内容各自烘焙，禁止共享几何）。
     * 每次取整体包围盒最长轴，以三角形质心中位数为切分面（两侧三角形数均衡）；
     * 完全落在一侧的网格克隆后整体归属，跨面的网格切分几何（仅mergePrimitive模式，否则按中心归属）。
     * @param {object[]} items
     * @param {number} depth
     * @returns {{items: object[], children: object[]|null}}
    */
    function splitSpatially(items, depth) {
        const node = { items, children: null };
        const totalBytes = items.reduce((sum, item) => sum + item.byteLength, 0);
        const totalTriangles = items.reduce((sum, item) => sum + getTrianglesCount(item.mesh.geometry), 0);
        if (totalBytes <= tileExpectSize || totalTriangles < MIN_TRIANGLES_PER_TILE || depth >= MAX_SPLIT_DEPTH)
            return node;
        const bucketBox = new Box3();
        items.forEach(item => bucketBox.union(item.mesh.geometry.boundingBox));
        const size = bucketBox.getSize(new Vector3());
        const axis = size.x >= size.y && size.x >= size.z ? 0 : (size.y >= size.z ? 1 : 2);
        if (size.getComponent(axis) <= 0)
            return node;
        //所有三角形质心在指定轴上的分量，取中位数作为切分面位置
        const centers = [];
        items.forEach(item => collectTriangleCenters(item.mesh.geometry, axis, centers));
        centers.sort((a, b) => a - b);
        const splitValue = centers[Math.floor(centers.length / 2)];
        const left = [], right = [];
        items.forEach(item => {
            const box = item.mesh.geometry.boundingBox;
            if (box.max.getComponent(axis) <= splitValue) {
                left.push(cloneItem(item));
            } else if (box.min.getComponent(axis) >= splitValue) {
                right.push(cloneItem(item));
            } else if (options.mergePrimitive) {
                splitItemByAxis(item, axis, splitValue, left, right);
            } else {
                (box.getCenter(new Vector3()).getComponent(axis) < splitValue ? left : right).push(cloneItem(item));
            }
        });
        //某一侧为空说明质心重合等退化情况，无法继续推进
        if (left.length === 0 || right.length === 0)
            return node;
        node.children = [splitSpatially(left, depth + 1), splitSpatially(right, depth + 1)];
        return node;
    };

    //克隆切分项（几何与网格独立，供子节点瓦片独立烘焙）
    function cloneItem(item) {
        const mesh = new Mesh(item.mesh.geometry.clone(), item.material);
        mesh.name = item.mesh.name;
        if (defined(item.mesh.userData.segments))
            mesh.userData.segments = item.mesh.userData.segments;
        return makeItem(mesh, item.material);
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
            //切分面恰好落在网格内但质心全在一侧：整件克隆归属多数侧（父节点保留原件）
            (leftTriangles > 0 ? left : right).push(cloneItem(item));
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
                // 实例化组:锚点/旋转已premultiply进实例矩阵,几何必须保持局部坐标,不得烘焙
                if (element.userData.isInstanced)
                    return;
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
 * 将实例化组展开回逐实例网格(spatial切分模式回退路径):
 * 每实例以其矩阵重建Mesh(position/quaternion/scale),几何共享,
 * 后续mergeMeshes按matrixWorld克隆烘焙,与未坍缩时的行为一致。
 * @param {Scene} scene
*/
function expandInstancedMeshes(scene) {
    const removals = [], additions = [];
    scene.traverse(obj => {
        if (!obj.userData || !obj.userData.isInstanced)
            return;
        removals.push(obj);
        obj.userData.instances.forEach(instance => {
            const mesh = new Mesh(obj.geometry, obj.material);
            mesh.name = instance.name;
            mesh.applyMatrix4(instance.matrix);
            //实例矩阵是世界矩阵,展开网格须挂在scene根(单位变换),否则父节点变换会被二次应用
            additions.push({ parent: scene, mesh });
        });
    });
    if (removals.length === 0)
        return;
    removals.forEach(obj => obj.parent && obj.parent.remove(obj));
    additions.forEach(({ parent, mesh }) => parent.add(mesh));
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

