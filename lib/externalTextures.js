'use strict';
const crypto = require("crypto");

/**
 * 将GLB内嵌贴图外置为独立文件并跨瓦片按内容去重：
 * 空间切分后同一材质的贴图会重复内嵌在多个瓦片中，外置共享可显著
 * 减小瓦片体积与加载端显存占用。就地修改解析后的GLB工作对象。
 *
 * @param {{json: object, bin: Buffer|null}} parts glbParts.parseGlbParts产物（就地修改）
 * @returns {Array<{name: string, data: Buffer}>} 本次新落盘的贴图文件，
 *         name为相对于瓦片输出目录的路径（textures/xxx.ext）
 */
function applyExternalizeTextures(parts) {
    const { json, bin: binData } = parts;
    if (!json.images || json.images.length === 0 || !binData)
        return [];

    const mimeExtensions = { 'image/png': 'png', 'image/jpeg': 'jpg' };
    // 模块级去重缓存：同一进程内（单次转换）相同内容贴图只落盘一次
    if (!applyExternalizeTextures.shared)
        applyExternalizeTextures.shared = new Map();

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
        if (!applyExternalizeTextures.shared.has(hash)) {
            applyExternalizeTextures.shared.set(hash, name);
            textureFiles.push({ name, data: bytes });
        }
        image.uri = applyExternalizeTextures.shared.get(hash);
        delete image.bufferView;
        removedViews.add(viewIndex);
    });
    if (removedViews.size === 0)
        return textureFiles;

    // 重建BIN块：剔除贴图bufferView并整体前移，重映射所有引用索引
    const oldViews = json.bufferViews;
    const keptIndexes = oldViews.map((_, i) => i).filter(i => !removedViews.has(i));
    const pad4 = n => (n + 3) & ~3;
    const pad8 = n => (n + 7) & ~7;
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
    // 视图按4字节对齐排布，缓冲整体补齐至8字节（与独立序列化后下游所见长度一致）
    const newBinLength = pad4(offset);
    const newBin = Buffer.alloc(pad8(newBinLength));
    newBinParts.forEach(part => part.bytes.copy(newBin, part.start));
    parts.bin = newBin;

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
    return textureFiles;
};

function defined(value) {
    return value !== undefined && value !== null;
};

module.exports = { applyExternalizeTextures };
