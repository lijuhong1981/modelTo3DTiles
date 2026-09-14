'use strict';

/**
 * 为瓦片GLB附加EXT_mesh_features与EXT_structural_metadata扩展，
 * 使加载端（如Cesium）可按构件（featureId）拾取并查询属性。
 *
 * 前置条件：几何体已带_FEATURE_ID_0顶点属性（值为瓦片内featureId，
 * 由processScene在合并时注入，GLTFExporter会原样导出下划线自定义属性）。
 *
 * @param {Buffer} glbBuffer GLTFExporter输出的GLB
 * @param {string[]} featureNames featureId对应的构件名称列表
 * @returns {Buffer} 附加扩展后的GLB
 */
function attachFeatureMetadata(glbBuffer, featureNames) {
    if (!Array.isArray(featureNames) || featureNames.length === 0)
        return glbBuffer;

    // 解析GLB：12字节头 + JSON块(8字节块头+数据) + BIN块(8字节块头+数据)
    if (glbBuffer.readUInt32LE(0) !== 0x46546c67)
        throw new Error('不是有效的GLB文件');
    const jsonChunkLength = glbBuffer.readUInt32LE(12);
    if (glbBuffer.readUInt32LE(16) !== 0x4e4f534a) // 'JSON'
        throw new Error('GLB第一个块不是JSON块');
    const json = JSON.parse(glbBuffer.slice(20, 20 + jsonChunkLength).toString('utf8'));
    const binChunkHeader = 20 + jsonChunkLength;
    if (binChunkHeader + 8 > glbBuffer.length || glbBuffer.readUInt32LE(binChunkHeader + 4) !== 0x004e4942) // 'BIN\0'
        return glbBuffer; // 无BIN块，无法追加属性表数据
    const binChunkLength = glbBuffer.readUInt32LE(binChunkHeader);
    const binData = Buffer.from(glbBuffer.slice(binChunkHeader + 8, binChunkHeader + 8 + binChunkLength));

    // 构造name字符串属性数据：uint32偏移数组(count+1个) + UTF8字符串拼接区
    const offsets = new Uint32Array(featureNames.length + 1);
    const parts = [];
    let byteOffset = 0;
    featureNames.forEach((name, i) => {
        offsets[i] = byteOffset;
        const part = Buffer.from(String(name), 'utf8');
        parts.push(part);
        byteOffset += part.length;
    });
    offsets[featureNames.length] = byteOffset;
    const stringData = Buffer.concat(parts);

    // 追加到BIN块末尾（GLTFExporter输出的BIN已按8字节对齐，偏移数组天然满足4字节对齐）
    const valuesOffset = binData.length;
    const stringOffset = valuesOffset + offsets.byteLength;
    const newBin = Buffer.alloc(stringOffset + stringData.length);
    binData.copy(newBin, 0);
    Buffer.from(offsets.buffer, offsets.byteOffset, offsets.byteLength).copy(newBin, valuesOffset);
    stringData.copy(newBin, stringOffset);

    const bufferViews = json.bufferViews || (json.bufferViews = []);
    const valuesView = bufferViews.push({ buffer: 0, byteOffset: valuesOffset, byteLength: offsets.byteLength }) - 1;
    const stringView = bufferViews.push({ buffer: 0, byteOffset: stringOffset, byteLength: stringData.length }) - 1;
    if (json.buffers && json.buffers[0])
        json.buffers[0].byteLength = newBin.length;

    // 每个带_FEATURE_ID_0的图元挂EXT_mesh_features，指向属性表0
    const featureCount = featureNames.length;
    let hasFeaturePrimitives = false;
    (json.meshes || []).forEach(mesh => {
        (mesh.primitives || []).forEach(primitive => {
            if (!primitive.attributes || primitive.attributes._FEATURE_ID_0 === undefined)
                return;
            hasFeaturePrimitives = true;
            primitive.extensions = primitive.extensions || {};
            primitive.extensions.EXT_mesh_features = {
                featureIds: [{ featureCount, attribute: 0, propertyTable: 0 }],
            };
        });
    });
    if (!hasFeaturePrimitives)
        return glbBuffer;

    json.extensionsUsed = Array.from(new Set(
        [...(json.extensionsUsed || []), 'EXT_mesh_features', 'EXT_structural_metadata']));

    json.extensions = json.extensions || {};
    json.extensions.EXT_structural_metadata = {
        schema: {
            id: 'modelTo3DTiles-feature-schema',
            classes: {
                feature: {
                    properties: {
                        name: { type: 'STRING' },
                    },
                },
            },
        },
        propertyTables: [{
            class: 'feature',
            count: featureCount,
            properties: {
                name: {
                    values: stringView,        // 字符串数据区（UTF8字节）
                    stringOffsets: valuesView, // uint32偏移数组（count+1个，UINT32为默认stringOffsetType）
                },
            },
        }],
    };

    // 重新序列化GLB（JSON块与BIN块均按8字节对齐）
    const pad8 = n => (n + 7) & ~7;
    let jsonStr = JSON.stringify(json);
    const jsonPaddedLength = pad8(Buffer.byteLength(jsonStr));
    jsonStr += ' '.repeat(jsonPaddedLength - Buffer.byteLength(jsonStr));
    const binPaddedLength = pad8(newBin.length);
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
    newBin.copy(output, cursor + 8);
    return output;
};

module.exports = { attachFeatureMetadata };
