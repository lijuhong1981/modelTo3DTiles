const path = require('path');
const fs = require('fs');
const { Document, NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const draco3d = require('draco3dgltf');
const gltfPipeline = require('gltf-pipeline');

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

    //gltf-transform仅支持glTF 2.0(1.0资产直接抛Unsupported glTF version);
    //检测到1.0输入时先用gltf-pipeline升级(updateVersion阶段同时将旧扩展材质
    //如KHR_materials_common转为PBR),升级后buffer/贴图内嵌为data URI,
    //readJSON/readBinary无需再访问外部资源文件
    const upgraded = await upgradeToGltf2(inputPath);
    const document = upgraded !== null
        ? (upgraded.json !== undefined
            ? await io.readJSON({ json: upgraded.json, resources: {} })
            : await io.readBinary(new Uint8Array(upgraded.glb)))
        : await io.read(inputPath);
    console.timeEnd('loadGLTFTime');
    return document;
};

/**
 * 检测glTF 1.0输入并升级为2.0。
 * @param {string} inputPath - GLTF/GLB文件路径
 * @returns {Promise(object|null)} 1.0时返回{json}或{glb}(升级产物),2.0返回null
 */
async function upgradeToGltf2(inputPath) {
    const ext = path.extname(inputPath).toLowerCase();
    const resourceDirectory = path.dirname(inputPath);
    if (ext === '.glb') {
        //只读12字节头部探测容器版本,避免GB级GLB全量读入两次(探测+io.read)
        const fd = fs.openSync(inputPath, 'r');
        const header = Buffer.alloc(12);
        fs.readSync(fd, header, 0, 12, 0);
        fs.closeSync(fd);
        //GLB v1(含KHR_binary_glTF)由gltf-pipeline的parseGlb解析
        if (header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(4) !== 1) return null;
        console.log('检测到glTF 1.0输入(GLB v1),使用gltf-pipeline升级至2.0: ' + inputPath);
        const results = await gltfPipeline.processGlb(fs.readFileSync(inputPath), { resourceDirectory });
        return { glb: results.glb };
    }
    const json = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    //1.0旧文件可能只在根级version声明(gltf-pipeline的updateVersion同样优先读它)
    const version = parseFloat(json.version ?? (json.asset && json.asset.version));
    if (isNaN(version) || version >= 2) return null;
    console.log('检测到glTF 1.0输入,使用gltf-pipeline升级至2.0: ' + inputPath);
    const results = await gltfPipeline.processGltf(json, { resourceDirectory });
    return { json: results.gltf };
}
