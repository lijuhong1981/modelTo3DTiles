const loadFBX = require("./loadFBX");
const processScene = require("./processScene");
const processTiles = require("./processTiles");

module.exports = fbxTo3DTiles;

async function fbxTo3DTiles(inputPath, options) {
    console.log('loadFbx:', inputPath);
    const scene = await loadFBX(inputPath, options);
    const tiles = await processScene(scene, options);
    await processTiles(tiles, options);
};