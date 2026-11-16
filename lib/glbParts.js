'use strict';

/**
 * GLB解析/序列化公共件。
 * 后处理三阶段（贴图外置/实例扩展注入/属性表附加）共用同一份解析结果
 * 与一次序列化，替代此前每阶段各自JSON.parse全量JSON、复制整个BIN、
 * 重新拼接GLB的三趟往返（大瓦片上开销可观）。
 *
 * 约定：parts.bin始终为8字节对齐的Buffer（各阶段追加内容后补齐对齐，
 * 与独立序列化后再解析时下游所见长度一致）；无BIN块时为null。
 */

/**
 * 解析GLB为{json, bin}工作对象。bin为BIN块的Buffer视图（不复制，各阶段只读后重建）。
 * @param {Buffer} glbBuffer
 * @returns {{json: object, bin: Buffer|null}}
 */
function parseGlbParts(glbBuffer) {
    if (glbBuffer.readUInt32LE(0) !== 0x46546c67)
        throw new Error('不是有效的GLB文件');
    const jsonChunkLength = glbBuffer.readUInt32LE(12);
    if (glbBuffer.readUInt32LE(16) !== 0x4e4f534a) // 'JSON'
        throw new Error('GLB第一个块不是JSON块');
    const json = JSON.parse(glbBuffer.slice(20, 20 + jsonChunkLength).toString('utf8'));
    const binChunkHeader = 20 + jsonChunkLength;
    if (binChunkHeader + 8 > glbBuffer.length || glbBuffer.readUInt32LE(binChunkHeader + 4) !== 0x004e4942)
        return { json, bin: null }; // 无BIN块
    const binChunkLength = glbBuffer.readUInt32LE(binChunkHeader);
    return { json, bin: glbBuffer.slice(binChunkHeader + 8, binChunkHeader + 8 + binChunkLength) };
}

/**
 * 序列化{json, bin}为GLB（JSON块与BIN块均按8字节对齐）。
 * @param {{json: object, bin: Buffer|null}} parts
 * @returns {Buffer}
 */
function serializeGlbParts(parts) {
    const pad8 = n => (n + 7) & ~7;
    const hasBin = parts.bin !== null;
    const binLength = hasBin ? parts.bin.length : 0;
    let jsonStr = JSON.stringify(parts.json);
    const jsonPaddedLength = pad8(Buffer.byteLength(jsonStr));
    jsonStr += ' '.repeat(jsonPaddedLength - Buffer.byteLength(jsonStr));
    const binPaddedLength = pad8(binLength);
    const totalLength = 12 + 8 + jsonPaddedLength + (hasBin ? 8 + binPaddedLength : 0);
    const output = Buffer.alloc(totalLength);
    output.write('glTF', 0, 'ascii');
    output.writeUInt32LE(2, 4);           // glTF版本
    output.writeUInt32LE(totalLength, 8); // 文件总长
    output.writeUInt32LE(jsonPaddedLength, 12);
    output.write('JSON', 16, 'ascii');
    output.write(jsonStr, 20, 'utf8');
    if (hasBin) {
        let cursor = 20 + jsonPaddedLength;
        output.writeUInt32LE(binPaddedLength, cursor);
        output.writeUInt32LE(0x004e4942, cursor + 4); // 'BIN\0'
        parts.bin.copy(output, cursor + 8);
    }
    return output;
}

module.exports = { parseGlbParts, serializeGlbParts };
