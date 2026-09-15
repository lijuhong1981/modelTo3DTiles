const { Cartesian3, Matrix4, Transforms } = require("cesium");
const fsExtra = require("fs-extra");
const path = require("path");
import { Box3, Sphere, Vector3, Matrix4 as ThreeMatrix4 } from "three";
const { Tile } = require("./processScene");
const { mergeGeometries } = require("./Utils");
const writeScene = require("./writeScene");

/**
 * @import { Tile } from "./processScene";
 * @import { Box3, BufferGeometry, Sphere } from "three";
*/

const yUpToZUpMatrix = new ThreeMatrix4().makeRotationAxis(new Vector3(1.0, 0.0, 0.0), Math.PI / 2);

/**
 * 递归处理瓦片树并生成3DTiles数据（LOD层级结构）：
 * 每个节点输出瓦片内容与包围盒，内部节点的geometricError取包围盒对角线
 * （远景渲染粗层、近景refine细层），叶子节点geometricError为0。
 * @param {{tile: Tile|null, children: Array}} rootNode processScene返回的瓦片树根节点
 * @param {object} options
 * @returns {Promise}
*/
async function processTiles(rootNode, options) {
    console.time('processTilesTime');

    const tileset = {
        asset: {
            generatetool: "modelTo3DTiles",
            version: "1.1"
        },
        geometricError: 0,
        refine: "REPLACE",
        root: {},
    };
    let vertexesCount = 0, trianglesCount = 0, leafTiles = 0, totalTiles = 0;

    /**
     * 递归写出瓦片树节点
     * @param {{tile: Tile|null, children: Array}} node
     * @returns {Promise<{json: object, box: Box3}>}
    */
    async function writeNode(node) {
        const isLeaf = !node.children || node.children.length === 0;
        let box = null;
        const json = {
            boundingVolume: {},
            geometricError: 0,
            refine: "REPLACE",
        };
        if (node.tile) {
            totalTiles++;
            if (isLeaf) {
                leafTiles++;
                vertexesCount += node.tile.vertexesCount;
                trianglesCount += node.tile.trianglesCount;
            }
            box = computeBoundingVolume(node.tile);
            json.content = { uri: await writeTile(node.tile, options) };
        }
        if (!isLeaf) {
            json.children = [];
            let unionBox = box ? box.clone() : null;
            for (const child of node.children) {
                const result = await writeNode(child);
                json.children.push(result.json);
                unionBox = unionBox ? unionBox.union(result.box) : result.box.clone();
            }
            if (!box)
                box = unionBox;
        }
        if (box) {
            json.boundingVolume.box = convertBoundingBox(box);
            if (!node.tile) {
                //无内容节点（material模式的合成根）：必须始终refine到有内容的子节点
                json.geometricError = 1e7;
            } else {
                //geometricError按"切换距离"标定（非几何误差，同几何不同聚合粒度）：
                //ge = 包围盒对角线/64，在默认maxSSE=16、900px视口下约于1.3倍对角线距离处refine子层，
                //即模型充满屏幕的取景距离内保持粗层，相机推进到瓦片尺度附近才细化
                json.geometricError = isLeaf ? 0 : box.getSize(new Vector3()).length() / 64;
            }
        }
        return { json, box };
    }

    const rootResult = await writeNode(rootNode);
    tileset.root = rootResult.json;
    const rootBox = rootResult.box;
    tileset.geometricError = rootBox
        ? rootBox.getBoundingSphere(new Sphere()).radius * 2
        : 0;

    if (options.noneTransform) {
        tileset.root.transform = Matrix4.pack(Matrix4.IDENTITY, []);
    } else {
        const lngLatAlt = options.lngLatAlt;
        if (options.clampToGround && rootBox) {
            const center = rootBox.getCenter(new Vector3());
            const size = rootBox.getSize(new Vector3());
            lngLatAlt.altitude = size.y / 2 - center.y;
        }
        const origin = Cartesian3.fromDegrees(lngLatAlt.longitude, lngLatAlt.latitude, lngLatAlt.altitude);
        const transform = Transforms.eastNorthUpToFixedFrame(origin);
        tileset.root.transform = Matrix4.pack(transform, []);
    }
    const tilesetPath = path.join(options.outputDirectory, 'tileset.json');
    await fsExtra.outputJson(tilesetPath, tileset, { spaces: 2 });
    console.log('write tileset.json finished.',
        '瓦片总数:', totalTiles, '(叶子', leafTiles + ')',
        '叶层顶点:', vertexesCount, '叶层三角面:', trianglesCount);
    console.timeEnd('processTilesTime');

    /**
     * 计算瓦片几何体的轴对齐包围盒（threejs空间）
     * @param {Tile} tile
     * @returns {Box3}
    */
    function computeBoundingVolume(tile) {
        const box = new Box3();
        box.setFromObject(tile.scene);
        return box;
    };
    /**
     * 转换包围盒（threejs的Y-up空间 → 3DTiles瓦片的Z-up空间）
     * @param {Box3} box
     * @returns {number[]} 3DTiles的box数组:[中心点xyz, x半轴xyz, y半轴xyz, z半轴xyz]共12个数
    */
    function convertBoundingBox(box) {
        const center = box.getCenter(new Vector3()).applyMatrix4(yUpToZUpMatrix);
        const size = box.getSize(new Vector3());
        //yUpToZUpMatrix为纯旋转矩阵（无平移分量），可直接作用于半轴向量
        const halfXAxis = new Vector3(size.x / 2, 0, 0).applyMatrix4(yUpToZUpMatrix);
        const halfYAxis = new Vector3(0, size.y / 2, 0).applyMatrix4(yUpToZUpMatrix);
        const halfZAxis = new Vector3(0, 0, size.z / 2).applyMatrix4(yUpToZUpMatrix);
        return [
            center.x, center.y, center.z,
            halfXAxis.x, halfXAxis.y, halfXAxis.z,
            halfYAxis.x, halfYAxis.y, halfYAxis.z,
            halfZAxis.x, halfZAxis.y, halfZAxis.z,
        ];
    }
    /**
     * 处理单个瓦片，生成内容文件
     * @param {Tile} tile
     * @param {object} options
     * @returns {Promise<string>}
    */
    async function writeTile(tile, options) {
        const tileName = await writeScene(tile.scene, options, tile.features);
        console.log('write tile ' + tile.name + ' finished, byteLength = ' + tile.byteLength + ', features = ' + tile.features.length);
        return tileName;
    };
};

module.exports = processTiles;
