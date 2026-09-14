const fsExtra = require("fs-extra");
const path = require("path");
const gltfPipeline = require("gltf-pipeline");
const { attachFeatureMetadata } = require("./featureMetadata");
const { externalizeTextures } = require("./externalTextures");
const { createB3dm } = require("./b3dm");
import { GLTFExporter } from "./exporters/GLTFExporter.js";

/**
 * @import { Scene } from "three";
*/

const gltfExporter = new GLTFExporter();

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
    //Draco几何压缩：在外置贴图之前执行(此阶段贴图仍内嵌,gltf-pipeline无需读外部资源)
    if (options.draco) {
        console.time('dracoCompress');
        const compressed = await gltfPipeline.processGlb(glbBuffer, { dracoOptions: { compressionLevel: 7 } });
        glbBuffer = Buffer.from(compressed.glb);
        console.timeEnd('dracoCompress');
    }
    const externalized = externalizeTextures(glbBuffer);
    for (const file of externalized.textureFiles)
        await fsExtra.outputFile(path.join(options.outputDirectory, file.name), file.data);
    const tileGlbBuffer = attachFeatureMetadata(externalized.glbBuffer, featureNames);
    const useB3dm = options.b3dm !== false;
    //b3dm规范：内嵌glTF使用EXT_mesh_features时FeatureTable为空（BATCH_LENGTH为0）
    const tileBuffer = useB3dm ? createB3dm(tileGlbBuffer) : tileGlbBuffer;
    const tileName = scene.name + (useB3dm ? '.b3dm' : '.glb');
    const tilePath = path.join(options.outputDirectory, tileName);
    await fsExtra.outputFile(tilePath, tileBuffer);
    console.log('writed ' + tileName + ' byteLength = ' + tileBuffer.byteLength
        + (externalized.textureFiles.length ? ', externalTextures = ' + externalized.textureFiles.length : '')
        + (featureNames ? ', features = ' + featureNames.length : ''));
    console.timeEnd('writeSceneTime');
    return tileName;
};

module.exports = writeScene;
