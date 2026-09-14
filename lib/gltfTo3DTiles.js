const loadGLTF = require("./loadGLTF");
const processGltfDoc = require("./processGltfDoc");
const processScene = require("./processScene");
const processTiles = require("./processTiles");

module.exports = gltfTo3DTiles;

async function gltfTo3DTiles(inputPath, options) {
    console.log('loadGLTF:', inputPath);
    const gltfDoc = await loadGLTF(inputPath, options);
    const scene = await processGltfDoc(gltfDoc, options);
    const tiles = await processScene(scene, options);
    await processTiles(tiles, options);
};