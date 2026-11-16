const fsExtra = require("fs-extra");
const path = require("path");
const gltfPipeline = require("gltf-pipeline");
const { applyAttachFeatureMetadata } = require("./featureMetadata");
const { applyInjectInstanceMetadata } = require("./instanceMetadata");
const { applyExternalizeTextures } = require("./externalTextures");
const { parseGlbParts, serializeGlbParts } = require("./glbParts");
const { createB3dm } = require("./b3dm");
import { GLTFExporter } from "./exporters/GLTFExporter.js";

/**
 * @import { Scene } from "three";
*/

const gltfExporter = new GLTFExporter();

// Draco编码器(WASM)对超大单图元会因内存耗尽而abort；超过该三角形数的瓦片跳过压缩。
const MAX_DRACO_TRIANGLES = 1000000;
// 一次压缩失败后置true（WASM堆往往已耗尽），后续瓦片直接跳过压缩，避免反复长时间abort。
let dracoBroken = false;

/**
 * 场景模型生成瓦片内容文件并返回文件名。
 * 内嵌贴图外置为共享文件（跨瓦片按内容去重），传入featureNames时为GLB附加
 * EXT_mesh_features/EXT_structural_metadata扩展，支持加载端按构件拾取。
 * 默认以b3dm容器输出（3D Tiles经典格式，FeatureTable为空、构件信息由内嵌
 * glTF的EXT_mesh_features承载）；options.b3dm为false时直接输出glb瓦片。
 * @param {Scene} scene
 * @param {object} options
 * @param {string[]} [featureNames] featureId对应的构件名称列表
 * @returns {Promise<string>}
*/
async function writeScene(scene, options, featureNames) {
    console.time('writeSceneTime');
    const gltfBuffer = await gltfExporter.parseAsync(scene, { binary: true });
    let glbBuffer = Buffer.from(gltfBuffer);
    //gltf-pipeline统一处理:无论是否启用Draco,均执行内置阶段——未使用元素清理
    //(removeUnusedElements,默认keepUnusedElements=false)与glTF 1.0→2.0升级(updateVersion);
    //在外置贴图之前执行(此阶段贴图仍内嵌,gltf-pipeline无需读外部资源)。
    //管线处理属增益而非必需:任一阶段失败均回退为导出器原始GLB,不使转换中断
    const pipelineOptions = {};
    if (options.draco && !dracoBroken) {
        const triangles = countSceneTriangles(scene);
        if (triangles <= MAX_DRACO_TRIANGLES) {
            // 位置量化默认11bit对锚点后±百米级的世界坐标网格误差可达9cm,
            // 与实例化构件(亚毫米)相邻时接缝错位显形;提至16bit(≈3mm)消除可见偏移。
            // 纹理坐标默认10bit:大幅面重复贴图(楼板砖缝)UV跨度数十周期,
            // 量化步长≈0.08导致面内贴图扭曲显形;提至14bit消除可见歪斜
            pipelineOptions.dracoOptions = { compressionLevel: 7, quantizePositionBits: 16, quantizeTexcoordBits: 14 };
        } else {
            console.warn('瓦片三角形数 ' + triangles + ' 超出Draco安全上限 ' + MAX_DRACO_TRIANGLES + '，跳过压缩');
        }
    }
    console.time('gltfPipeline');
    try {
        const processed = await gltfPipeline.processGlb(glbBuffer, pipelineOptions);
        glbBuffer = Buffer.from(processed.glb);
    } catch (err) {
        if (pipelineOptions.dracoOptions) {
            // Draco WASM编码器abort时抛RuntimeError,堆往往已耗尽,禁用后续压缩
            dracoBroken = true;
            console.warn('Draco压缩失败，本瓦片及后续瓦片回退为未压缩: ' + (err && err.message ? err.message : err));
        } else {
            console.warn('gltf-pipeline处理失败，本瓦片回退为原始GLB: ' + (err && err.message ? err.message : err));
        }
        //glbBuffer保持导出器原始输出(processGlb内部另行构造对象,失败不影响原值)
    } finally {
        console.timeEnd('gltfPipeline');
    }
    //后处理单趟化:贴图外置→实例扩展注入→属性表附加共用一次解析与一次序列化
    //(旧流程每阶段各自parse全量JSON/复制整BIN/重拼GLB,大瓦片开销可观)
    const parts = parseGlbParts(glbBuffer);
    const textureFiles = applyExternalizeTextures(parts);
    //实例化组注入EXT_mesh_gpu_instancing/EXT_instance_features(须在属性表附加前,
    //两次BIN追加按顺序递增偏移;实例数据不经Draco,体积远小于展开几何)
    const instancedMeshes = [];
    scene.traverse(obj => {
        if (obj.isMesh && obj.userData.isInstanced)
            instancedMeshes.push(obj);
    });
    applyInjectInstanceMetadata(parts, instancedMeshes);
    applyAttachFeatureMetadata(parts, featureNames, options.metadata);
    const tileGlbBuffer = serializeGlbParts(parts);
    for (const file of textureFiles)
        await fsExtra.outputFile(path.join(options.outputDirectory, file.name), file.data);
    const useB3dm = options.b3dm !== false;
    //b3dm规范：内嵌glTF使用EXT_mesh_features时FeatureTable为空（BATCH_LENGTH为0）
    const tileBuffer = useB3dm ? createB3dm(tileGlbBuffer) : tileGlbBuffer;
    const tileName = scene.name + (useB3dm ? '.b3dm' : '.glb');
    const tilePath = path.join(options.outputDirectory, tileName);
    await fsExtra.outputFile(tilePath, tileBuffer);
    console.log('writed ' + tileName + ' byteLength = ' + tileBuffer.byteLength
        + (textureFiles.length ? ', externalTextures = ' + textureFiles.length : '')
        + (featureNames ? ', features = ' + featureNames.length : ''));
    console.timeEnd('writeSceneTime');
    return tileName;
};

/**
 * 统计场景内三角形总数（用于判断是否超过Draco压缩安全上限）。
 * @param {Scene} scene
 * @returns {number}
 */
function countSceneTriangles(scene) {
    let count = 0;
    scene.traverse(obj => {
        if (obj.geometry && obj.geometry.attributes && obj.geometry.attributes.position) {
            const position = obj.geometry.attributes.position;
            count += obj.geometry.index ? obj.geometry.index.count / 3 : position.count / 3;
        }
    });
    return Math.floor(count);
}

module.exports = writeScene;
