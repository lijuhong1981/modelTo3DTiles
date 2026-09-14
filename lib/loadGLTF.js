const { Document, NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const draco3d = require('draco3dgltf');

module.exports = loadGLTF;

/**
 * 加载GLTF文件
 * @param {string} inputPath - GLTF文件路径
 * @param {object} options - 选项参数
 * @returns {Promise<Document>} GLTF文档
 */
async function loadGLTF(inputPath, options) {
    console.time('loadGLTFTime');

    // Configure I/O.
    const io = new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
            'draco3d.decoder': await draco3d.createDecoderModule(), // Optional.
            'draco3d.encoder': await draco3d.createEncoderModule(), // Optional.
        });

    // Read from URL.
    const document = await io.read(inputPath);
    console.timeEnd('loadGLTFTime');
    return document;
};