'use strict';

/**
 * 将GLB封装为b3dm（3D Tiles Batched 3D Model）瓦片容器。
 *
 * 本工具的构件信息由内嵌glTF的EXT_mesh_features/EXT_structural_metadata承载，
 * 按b3dm规范此时FeatureTable为空（BATCH_LENGTH为0）、不使用传统BatchTable。
 *
 * 布局：28字节头 + FeatureTable JSON（以空格填充使头+JSON总长8字节对齐，
 * 保证内嵌GLB起始位置8字节对齐） + GLB。
 *
 * @param {Buffer} glbBuffer 内嵌GLB
 * @returns {Buffer} b3dm容器
 */
function createB3dm(glbBuffer) {
    const featureTableJson = '{"BATCH_LENGTH":0}';
    const jsonPad = (8 - ((28 + Buffer.byteLength(featureTableJson)) % 8)) % 8;
    const featureTableBuffer = Buffer.from(featureTableJson + ' '.repeat(jsonPad), 'utf8');
    const totalLength = 28 + featureTableBuffer.length + glbBuffer.length;
    const output = Buffer.alloc(totalLength);
    output.write('b3dm', 0, 'ascii');
    output.writeUInt32LE(1, 4);                    // 版本
    output.writeUInt32LE(totalLength, 8);          // 文件总长
    output.writeUInt32LE(featureTableBuffer.length, 12); // FeatureTable JSON长度
    output.writeUInt32LE(0, 16);                   // FeatureTable Binary长度
    output.writeUInt32LE(0, 20);                   // BatchTable JSON长度
    output.writeUInt32LE(0, 24);                   // BatchTable Binary长度
    featureTableBuffer.copy(output, 28);
    glbBuffer.copy(output, 28 + featureTableBuffer.length);
    return output;
};

module.exports = { createB3dm };
