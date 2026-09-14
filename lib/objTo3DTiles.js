const loadObj = require("obj2gltf/lib/loadObj");
const defaultValue = require("./defaultValue");
const processObjData = require("./processObjData");
const processScene = require("./processScene");
const processTiles = require("./processTiles");
//#region test code
// const writeScene = require("./writeScene");
// const writeGltf = require("obj2gltf/lib/writeGltf");
// const createGltf = require("obj2gltf/lib/createGltf");
// const fsExtra = require("fs-extra");
// const path = require("path");
//#endregion test code

module.exports = objTo3DTiles;

/**
 * obj模型转换为3DTiles模型
 * @param {string} inputPath
 * @param {object} options
 * @returns {Promise<void>}
 */
async function objTo3DTiles(inputPath, options) {
    // obj文件不携带坐标轴元数据，默认按Z-up处理（BIM/CAD导出惯例），由obj2gltf统一转换为Y-up
    options.inputUpAxis = defaultValue(options.inputUpAxis, "Z");
    options.outputUpAxis = defaultValue(options.outputUpAxis, "Y");
    console.log('loadObj:', inputPath, 'upAxis:', options.inputUpAxis);
    console.time('loadObjTime');
    const objData = await loadObj(inputPath, options);
    console.timeEnd('loadObjTime');
    //#region test code
    // const nodes = objData.nodes.slice(0, 1);
    // objData.nodes = nodes;
    // objData.name = '1';
    //#endregion test code
    const scene = await processObjData(objData, options);
    const tiles = await processScene(scene, options);
    await processTiles(tiles, options);
    //#region test code
    // await writeScene(scene, options);
    // console.time('writeGltfTime');
    // const gltfData = await createGltf(objData, options);
    // const glbBuffer = await writeGltf(gltfData, options);
    // const glbName = objData.name + '.glb';
    // const glbPath = path.join(options.inputDirectory, glbName);
    // await fsExtra.outputFile(glbPath, glbBuffer);
    // console.timeEnd('writeGltfTime');
    //#endregion test code
};