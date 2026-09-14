const fsExtra = require("fs-extra");
const path = require("path");
const { attachFeatureMetadata } = require("./featureMetadata");
import { GLTFExporter } from "./exporters/GLTFExporter.js";

/**
 * @import { Scene } from "three";
*/

const gltfExporter = new GLTFExporter();

/**
 * 场景模型生成GLB文件并返回GLB文件名。
 * 传入featureNames时为GLB附加EXT_mesh_features/EXT_structural_metadata扩展，
 * 支持加载端按构件拾取。
 * @param {Scene} scene
 * @param {object} options
 * @param {string[]} [featureNames] featureId对应的构件名称列表
 * @returns {Promise<string>}
*/
async function writeScene(scene, options, featureNames) {
    console.time('writeSceneTime');
    const gltfBuffer = await gltfExporter.parseAsync(scene, { binary: true });
    const glbBuffer = attachFeatureMetadata(Buffer.from(gltfBuffer), featureNames);
    const glbName = scene.name + '.glb';
    const glbPath = path.join(options.outputDirectory, glbName);
    await fsExtra.outputFile(glbPath, glbBuffer);
    console.log('writed ' + glbName + ' glbBuffer.byteLength = ' + glbBuffer.byteLength + (featureNames ? ', features = ' + featureNames.length : ''));
    console.timeEnd('writeSceneTime');
    return glbName;
};

module.exports = writeScene;
