'use strict';
const { Matrix4, Quaternion, Vector3 } = require("three");

/**
 * 为瓦片GLB内的实例化组节点注入 EXT_mesh_gpu_instancing 与 EXT_instance_features:
 *  - 按节点名找到代表网格对应的glTF节点(GLTFExporter以object.name为节点名)
 *  - 每实例矩阵分解为TRANSLATION/ROTATION/SCALE实例属性(VVS 2027行主序f32)
 *  - userData.instanceFeatureIds(瓦片内featureId)写为_FEATURE_ID_0实例属性(uint16)
 *  - 节点声明EXT_instance_features,attribute:0指向_FEATURE_ID_0,propertyTable:0
 *    指向attachFeatureMetadata写入的属性表(实例名即构件键,行序与tile.features一致)
 *
 * 需在Draco压缩与贴图外置之后、attachFeatureMetadata之前调用(追加区偏移按当次
 * BIN长度计算,两次追加串行递增不冲突)。spike验证:Cesium 1.137实测该组合
 * 渲染/逐实例拾取/显隐/染色均可用,glTF 1.1瓦片与b3dm壳内嵌均可。
 *
 * @param {Buffer} glbBuffer GLTFExporter输出(已完成draco/外置贴图)的GLB
 * @param {import("three").Mesh[]} meshes 场景中的实例化组代表网格(userData.instances/instanceFeatureIds)
 * @returns {Buffer} 注入实例扩展后的GLB
 */
function injectInstanceMetadata(glbBuffer, meshes) {
    if (!meshes || meshes.length === 0)
        return glbBuffer;
    if (glbBuffer.readUInt32LE(0) !== 0x46546c67)
        throw new Error('不是有效的GLB文件');
    const jsonChunkLength = glbBuffer.readUInt32LE(12);
    if (glbBuffer.readUInt32LE(16) !== 0x4e4f534a) // 'JSON'
        throw new Error('GLB第一个块不是JSON块');
    const json = JSON.parse(glbBuffer.slice(20, 20 + jsonChunkLength).toString('utf8'));
    const binChunkHeader = 20 + jsonChunkLength;
    const binChunkLength = glbBuffer.readUInt32LE(binChunkHeader);
    const binData = Buffer.from(glbBuffer.slice(binChunkHeader + 8, binChunkHeader + 8 + binChunkLength));

    const bufferViews = json.bufferViews || (json.bufferViews = []);
    const accessors = json.accessors || (json.accessors = []);
    const nodes = json.nodes || [];
    // 节点名索引(代表网格名由processGltfDoc全局计数生成,瓦片内唯一)
    const nodeByName = new Map();
    nodes.forEach((node, i) => { if (node.name) nodeByName.set(node.name, i); });

    const alignUp = (n, a) => (n + a - 1) & ~(a - 1);
    let offset = binData.length;
    const appended = []; // {view, buffer} 按追加顺序
    function appendView(buffer) {
        offset = alignUp(offset, 4);
        const view = { buffer: 0, byteOffset: offset, byteLength: buffer.byteLength };
        bufferViews.push(view);
        appended.push({ view, buffer });
        offset += buffer.byteLength;
        return bufferViews.length - 1;
    }
    function minMaxOf(stride, array) {
        const min = new Array(stride).fill(Infinity), max = new Array(stride).fill(-Infinity);
        for (let i = 0; i < array.length; i += stride) {
            for (let k = 0; k < stride; k++) {
                if (array[i + k] < min[k]) min[k] = array[i + k];
                if (array[i + k] > max[k]) max[k] = array[i + k];
            }
        }
        return [min, max];
    }

    let injected = 0;
    const matrix = new Matrix4(), position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3();
    meshes.forEach(mesh => {
        const nodeIndex = nodeByName.get(mesh.name);
        if (nodeIndex === undefined) {
            console.warn('实例化组节点未在导出GLB中找到: ' + mesh.name);
            return;
        }
        const instances = mesh.userData.instances;
        const featureIds = mesh.userData.instanceFeatureIds;
        if (!instances || !featureIds || instances.length === 0)
            return;
        const count = instances.length;
        const translations = new Float32Array(count * 3);
        const rotations = new Float32Array(count * 4);
        const scales = new Float32Array(count * 3);
        const featureIdArray = new Uint16Array(count);
        for (let i = 0; i < count; i++) {
            matrix.copy(instances[i].matrix).decompose(position, quaternion, scale);
            position.toArray(translations, i * 3);
            quaternion.toArray(rotations, i * 4);
            scale.toArray(scales, i * 3);
            featureIdArray[i] = featureIds[i];
        }

        const accTranslation = accessors.push({
            bufferView: appendView(Buffer.from(translations.buffer)),
            componentType: 5126, count, type: 'VEC3',
            min: minMaxOf(3, translations)[0], max: minMaxOf(3, translations)[1],
        }) - 1;
        const accRotation = accessors.push({
            bufferView: appendView(Buffer.from(rotations.buffer)),
            componentType: 5126, count, type: 'VEC4',
        }) - 1;
        const accScale = accessors.push({
            bufferView: appendView(Buffer.from(scales.buffer)),
            componentType: 5126, count, type: 'VEC3',
            min: minMaxOf(3, scales)[0], max: minMaxOf(3, scales)[1],
        }) - 1;
        const accFeatureId = accessors.push({
            bufferView: appendView(Buffer.from(featureIdArray.buffer)),
            componentType: 5123, count, type: 'SCALAR',
        }) - 1;

        const node = nodes[nodeIndex];
        node.extensions = node.extensions || {};
        node.extensions.EXT_mesh_gpu_instancing = {
            attributes: {
                TRANSLATION: accTranslation,
                ROTATION: accRotation,
                SCALE: accScale,
                _FEATURE_ID_0: accFeatureId,
            },
        };
        node.extensions.EXT_instance_features = {
            featureIds: [{
                featureCount: Math.max(...featureIds) + 1,
                attribute: 0,
                propertyTable: 0,
            }],
        };
        injected++;
    });
    if (injected === 0)
        return glbBuffer;

    if (json.buffers && json.buffers[0])
        json.buffers[0].byteLength = offset;
    json.extensionsUsed = Array.from(new Set([...(json.extensionsUsed || []),
        'EXT_mesh_gpu_instancing', 'EXT_instance_features']));

    // 重新序列化GLB(JSON块与BIN块均按8字节对齐)
    const pad8 = n => (n + 7) & ~7;
    let jsonStr = JSON.stringify(json);
    const jsonPaddedLength = pad8(Buffer.byteLength(jsonStr));
    jsonStr += ' '.repeat(jsonPaddedLength - Buffer.byteLength(jsonStr));
    const binPaddedLength = pad8(offset);
    const totalLength = 12 + 8 + jsonPaddedLength + 8 + binPaddedLength;
    const output = Buffer.alloc(totalLength);
    output.write('glTF', 0, 'ascii');
    output.writeUInt32LE(2, 4);           // glTF版本
    output.writeUInt32LE(totalLength, 8); // 文件总长
    output.writeUInt32LE(jsonPaddedLength, 12);
    output.write('JSON', 16, 'ascii');
    output.write(jsonStr, 20, 'utf8');
    let cursor = 20 + jsonPaddedLength;
    output.writeUInt32LE(binPaddedLength, cursor);
    output.writeUInt32LE(0x004e4942, cursor + 4); // 'BIN\0'
    const newBin = Buffer.alloc(offset);
    binData.copy(newBin, 0);
    appended.forEach(({ view, buffer }) => buffer.copy(newBin, view.byteOffset));
    newBin.copy(output, cursor + 8);
    return output;
}

module.exports = { injectInstanceMetadata };
