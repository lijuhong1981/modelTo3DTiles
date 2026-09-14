'use strict';
// 初始化浏览器环境模拟（Three.js 和 GLTFExporter 需要）
// const { JSDOM } = require('jsdom');
// const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
//     url: "https://localhost/"
// });
// global.window = dom.window;
// global.document = dom.window.document;
// global.navigator = dom.window.navigator;
// // Polyfill URL API
// const blobs = new Map();
// global.window.URL = global.URL = {
//     createObjectURL: (blob) => {
//         const url = `blob://${Date.now()}-${Math.random().toString(36).slice(2)}`;
//         blobs.set(url, blob);
//         return url;
//     },
//     revokeObjectURL: (url) => {
//         blobs.delete(url);
//     },
// };
// Polyfill FileReader API
global.FileReader = class FileReader {
    constructor() {
        this.onloadend = null;
        this.result = null;
    }
    /**
     * @param {Blob} blob 
    */
    readAsArrayBuffer(blob) {
        // 异步读取 blob 数据
        blob.arrayBuffer().then(buffer => {
            this.result = buffer;
            if (this.onloadend) this.onloadend();
        });
    }
    /**
     * @param {Blob} blob 
    */
    readAsDataURL(blob) {
        // 异步转换为 base64 data URL
        blob.arrayBuffer().then(buffer => {
            const base64 = Buffer.from(buffer).toString('base64');
            this.result = `data:application/octet-stream;base64,${base64}`;
            if (this.onloadend) this.onloadend();
        });
    }
};

const fsExtra = require("fs-extra");
const obj2gltf = require("obj2gltf/lib/obj2gltf");
const path = require("path");
const defined = require("./defined");
const defaultValue = require("./defaultValue");
const objTo3DTiles = require("./objTo3DTiles");
const fbxTo3DTiles = require("./fbxTo3DTiles");
const gltfTo3DTiles = require("./gltfTo3DTiles");

module.exports = modelTo3DTiles;

/**
 * 精细模型转换至3DTiles模型
 * @param {string} inputPath
 * @param {obj2gltf} options
 * @returns {Promise<void>}
 */
async function modelTo3DTiles(inputPath, options) {
    const defaults = obj2gltf.defaults;
    options.binary = true;
    options.separate = false;
    options.separateTextures = false;
    options.checkTransparency = defaultValue(
        options.checkTransparency,
        defaults.checkTransparency
    );
    options.secure = defaultValue(options.secure, defaults.secure);
    options.packOcclusion = defaultValue(
        options.packOcclusion,
        defaults.packOcclusion
    );
    options.metallicRoughness = defaultValue(
        options.metallicRoughness,
        defaults.metallicRoughness
    );
    options.specularGlossiness = defaultValue(
        options.specularGlossiness,
        defaults.specularGlossiness
    );
    options.unlit = defaultValue(options.unlit, defaults.unlit);
    options.overridingTextures = defaultValue(
        options.overridingTextures,
        defaultValue.EMPTY_OBJECT
    );
    options.logger = defaultValue(options.logger, getDefaultLogger());
    options.writer = defaultValue(
        options.writer,
        getDefaultWriter(options.outputDirectory)
    );
    options.triangleWindingOrderSanitization = defaultValue(
        options.triangleWindingOrderSanitization,
        defaults.triangleWindingOrderSanitization
    );

    if (options.separateTextures && !defined(options.writer)) {
        throw new Error(
            "Either options.writer or options.outputDirectory must be defined when writing separate resources."
        );
    }

    if (
        options.metallicRoughness + options.specularGlossiness + options.unlit >
        1
    ) {
        throw new Error(
            "Only one material type may be set from [metallicRoughness, specularGlossiness, unlit]."
        );
    }

    if (
        defined(options.overridingTextures.metallicRoughnessOcclusionTexture) &&
        defined(options.overridingTextures.specularGlossinessTexture)
    ) {
        throw new Error(
            "metallicRoughnessOcclusionTexture and specularGlossinessTexture cannot both be defined."
        );
    }

    if (defined(options.overridingTextures.metallicRoughnessOcclusionTexture)) {
        options.metallicRoughness = true;
        options.specularGlossiness = false;
        options.packOcclusion = true;
    }

    if (defined(options.overridingTextures.specularGlossinessTexture)) {
        options.metallicRoughness = false;
        options.specularGlossiness = true;
    }
    console.log('model23dtiles:', inputPath, options);

    console.time('modelTo3DTilesTime');
    switch (options.format) {
        case 'obj':
            await objTo3DTiles(inputPath, options);
            break;
        case 'fbx':
            await fbxTo3DTiles(inputPath, options);
            break;
        case 'gltf':
        case 'glb':
            await gltfTo3DTiles(inputPath, options);
            break;
        default: throw new Error("Unsupported model format " + options.format);
    }
    console.timeEnd('modelTo3DTilesTime');
}

function getDefaultLogger() {
    return function (message) {
        console.log(message);
    };
}

function getDefaultWriter(outputDirectory) {
    if (defined(outputDirectory)) {
        return function (file, data) {
            const outputFile = path.join(outputDirectory, file);
            return fsExtra.outputFile(outputFile, data);
        };
    }
}