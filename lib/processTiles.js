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
 * 处理瓦片数据并生成3DTiles数据
 * @param {Array<Tile>} tiles
 * @param {object} options
 * @returns {Promise}
*/
async function processTiles(tiles, options) {
    console.time('processTilesTime');

    const boundingBoxes = [];
    const tileset = {
        asset: {
            generatetool: "modelTo3DTiles",
            version: "1.1"
        },
        geometricError: 0,
        refine: "REPLACE",
        root: {
            boundingVolume: {},
            children: [],
            geometricError: 0,
        }
    };
    let vertexesCount = 0, trianglesCount = 0;
    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        vertexesCount += tile.vertexesCount;
        trianglesCount += tile.trianglesCount;
        const boundingVolume = computeBoundingVolume(tile);
        boundingBoxes.push(boundingVolume);

        const glbName = await writeTile(tile, options);

        tileset.root.children.push({
            boundingVolume: {
                box: convertBoundingBox(boundingVolume),
            },
            content: {
                uri: glbName
            },
            geometricError: 0.0,
            refine: "REPLACE"
        });
    }

    //计算所有瓦片包围盒的并集作为根节点包围盒
    const wholeBox = new Box3();
    boundingBoxes.forEach(box => {
        wholeBox.union(box);
    });
    tileset.root.boundingVolume.box = convertBoundingBox(wholeBox);
    tileset.geometricError = tileset.root.geometricError = wholeBox.getBoundingSphere(new Sphere()).radius * 2;

    if (options.noneTransform) {
        // const translation = new Cartesian3(0, altitude, 0);
        // const transform = Matrix4.fromTranslation(translation);
        tileset.root.transform = Matrix4.pack(Matrix4.IDENTITY, []);
    } else {
        const lngLatAlt = options.lngLatAlt;
        if (options.clampToGround) {
            const center = wholeBox.getCenter(new Vector3());
            const size = wholeBox.getSize(new Vector3());
            lngLatAlt.altitude = size.y / 2 - center.y;
        }
        const origin = Cartesian3.fromDegrees(lngLatAlt.longitude, lngLatAlt.latitude, lngLatAlt.altitude);
        const transform = Transforms.eastNorthUpToFixedFrame(origin);
        tileset.root.transform = Matrix4.pack(transform, []);
    }
    const tilesetPath = path.join(options.outputDirectory, 'tileset.json');
    await fsExtra.outputJson(tilesetPath, tileset, { spaces: 2 });
    console.log('write tileset.json finished.');
    console.log('总计顶点数：', vertexesCount, '总计三角面数：', trianglesCount);
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
     * 处理单个瓦片，生成GLB文件
     * @param {Tile} tile
     * @param {object} options
     * @returns {Promise<string>}
    */
    async function writeTile(tile, options) {
        const glbName = await writeScene(tile.scene, options, tile.features);
        console.log('write tile ' + tile.name + ' finished, tile.byteLength = ' + tile.byteLength + ', features = ' + tile.features.length);
        return glbName;
    };
};

module.exports = processTiles;

