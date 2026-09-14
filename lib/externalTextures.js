'use strict';
const crypto = require("crypto");

/**
 * 将GLB内嵌贴图外置为独立文件并跨瓦片按内容去重：
 * 空间切分后同一材质的贴图会重复内嵌在多个瓦片中，外置共享可显著
 * 减小瓦片体积与加载端显存占用。返回瘦身后的GLB与待写入的贴图文件列表。
 *
 * @param {Buffer} glbBuffer GLTFExporter输出的GLB
 * @returns {{glbBuffer: Buffer, textureFiles: Array<{name: string, data: Buffer}>}}
 * textureFiles中的name为相对于瓦片输出目录的路径（textures/xxx.ext）
 */
function externalizeTextures(glbBuffer) {
    if (glbBuffer.readUInt32LE(0) !== 0x46546c67)
        throw new Error('不是有效的GLB文件');
    const jsonChunkLength = glbBuffer.readUInt32LE(12);
    const json = JSON.parse(glbBuffer.slice(20, 20 + jsonChunkLength).toString('utf8'));
    const binChunkHeader = 20 + jsonChunkLength;
    if (!json.images || json.images.length === 0 ||
        binChunkHeader + 8 > glbBuffer.length || glbBuffer.readUInt32LE(binChunkHeader + 4) !== 0x004e4942)
        return { glbBuffer, textureFiles: [] };
    const binChunkLength = glbBuffer.readUInt32LE(binChunkHeader);
    const binData = glbBuffer.slice(binChunkHeader + 8, binChunkHeader + 8 + binChunkLength);

    const mimeExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg' };
    // 模块级去重缓存：同一进程内（单次转换）相同内容贴图只落盘一次
    if (!externalizeTextures.shared)
        externalizeTextures.shared = new Map();

    const removedViews = new Set();
    const textureFiles = [];
    json.images.forEach(image => {
        if (defined(image.uri) || !defined(image.bufferView))
            return;
        const viewIndex = image.bufferView;
        const view = json.bufferViews[viewIndex];
        const bytes = Buffer.from(binData.slice(view.byteOffset, view.byteOffset + view.byteLength));
        const extension = mimeExtensions[image.mimeType] || 'png';
        const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16);
        const name = 'textures/' + hash + '.' + extension;
        if (!externalizeTextures.shared.has(hash)) {
            externalizeTextures.shared.set(hash, name);
            textureFiles.push({ name, data: bytes });
        }
        image.uri = externalizeTextures.shared.get(hash);
        delete image.bufferView;
        removedViews.add(viewIndex);
    });
    if (removedViews.size === 0)
        return { glbBuffer, textureFiles };

    // 重建BIN块：剔除贴图bufferView并整体前移，重映射所有引用索引
    const oldViews = json.bufferViews;
    const keptIndexes = oldViews.map((_, i) => i).filter(i => !removedViews.has(i));
    const pad4 = n => (n + 3) & ~3;
    let offset = 0;
    const newBinParts = [];
    const indexMap = new Map();
    keptIndexes.forEach(i => {
        const view = oldViews[i];
        const start = pad4(offset);
        newBinParts.push({ start, bytes: binData.slice(view.byteOffset, view.byteOffset + view.byteLength) });
        indexMap.set(i, { index: newBinParts.length - 1, offset: start });
        offset = start + view.byteLength;
    });
    const newBinLength = pad4(offset);
    const newBin = Buffer.alloc(newBinLength);
    newBinParts.forEach(part => part.bytes.copy(newBin, part.start));

    json.bufferViews = newBinParts.map((part, i) => {
        const old = oldViews[keptIndexes[i]];
        return {
            buffer: 0,
            byteOffset: part.start,
            byteLength: old.byteLength,
            ...(old.target !== undefined ? { target: old.target } : {}),
        };
    });
    (json.accessors || []).forEach(accessor => {
        if (defined(accessor.bufferView))
            accessor.bufferView = indexMap.get(accessor.bufferView).index;
    });
    // 修正EXT_structural_metadata属性表的bufferView引用（若已附加）
    const metadata = json.extensions && json.extensions.EXT_structural_metadata;
    (metadata ? metadata.propertyTables || [] : []).forEach(table => {
        Object.values(table.properties || {}).forEach(property => {
            ['values', 'stringOffsets', 'arrayOffsets'].forEach(key => {
                if (defined(property[key]))
                    property[key] = indexMap.get(property[key]).index;
            });
        });
    });
    if (json.buffers && json.buffers[0])
        json.buffers[0].byteLength = newBinLength;

    // 重新序列化GLB
    const pad8 = n => (n + 7) & ~7;
    let jsonStr = JSON.stringify(json);
    const jsonPaddedLength = pad8(Buffer.byteLength(jsonStr));
    jsonStr += ' '.repeat(jsonPaddedLength - Buffer.byteLength(jsonStr));
    const binPaddedLength = pad8(newBinLength);
    const totalLength = 12 + 8 + jsonPaddedLength + 8 + binPaddedLength;
    const output = Buffer.alloc(totalLength);
    output.write('glTF', 0, 'ascii');
    output.writeUInt32LE(2, 4);
    output.writeUInt32LE(totalLength, 8);
    output.writeUInt32LE(jsonPaddedLength, 12);
    output.write('JSON', 16, 'ascii');
    output.write(jsonStr, 20, 'utf8');
    let cursor = 20 + jsonPaddedLength;
    output.writeUInt32LE(binPaddedLength, cursor);
    output.writeUInt32LE(0x004e4942, cursor + 4);
    newBin.copy(output, cursor + 8);
    return { glbBuffer: output, textureFiles };
};

function defined(value) {
    return value !== undefined && value !== null;
};

module.exports = { externalizeTextures };
