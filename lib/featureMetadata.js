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
 * @param {{columns: Array, rows: Object}} [metadata] 属性表描述符（loadInputMetadata解析.metadata产出）；
 *        缺省时仅输出单一name列（值为构件名称），保持向后兼容
 * @returns {Buffer} 附加扩展后的GLB
 */
function attachFeatureMetadata(glbBuffer, featureNames, metadata) {
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

    const featureCount = featureNames.length;
    const columns = (metadata && Array.isArray(metadata.columns) && metadata.columns.length > 0)
        ? metadata.columns
        : [{ name: 'name', type: 'STRING' }];
    const rows = (metadata && metadata.rows) || {};

    // 逐列序列化为BIN追加块：STRING列 = stringOffsets(uint32数组) + values(UTF8字节)，
    // SCALAR列 = values(定长数值数组)。按组件类型记录对齐粒度（4字节或1字节）。
    const layout = [];  // {buffer, align, col, slot}
    const views = {};   // colName -> {values, stringOffsets?}
    columns.forEach(col => {
        views[col.name] = {};
        const values = featureNames.map(key => rowValue(rows, key, col.name));
        if (col.type === 'STRING') {
            const offsets = new Uint32Array(featureCount + 1);
            const parts = [];
            let byteOffset = 0;
            values.forEach((value, i) => {
                offsets[i] = byteOffset;
                const part = Buffer.from(String(value == null ? '' : value), 'utf8');
                parts.push(part);
                byteOffset += part.length;
            });
            offsets[featureCount] = byteOffset;
            layout.push({
                buffer: Buffer.from(offsets.buffer, offsets.byteOffset, offsets.byteLength),
                align: 4, col: col.name, slot: 'stringOffsets',
            });
            layout.push({
                buffer: Buffer.concat(parts),
                align: 1, col: col.name, slot: 'values',
            });
        } else {
            const array = makeScalarArray(values, col.componentType || 'FLOAT32');
            layout.push({
                buffer: Buffer.from(array.buffer, array.byteOffset, array.byteLength),
                align: 4, col: col.name, slot: 'values',
            });
        }
    });

    // 计算追加区偏移并生成bufferView（GLTFExporter输出的BIN已按8字节对齐，追加起点4字节对齐）
    const bufferViews = json.bufferViews || (json.bufferViews = []);
    const alignUp = (n, a) => (n + a - 1) & ~(a - 1);
    let offset = binData.length;
    layout.forEach(item => {
        offset = alignUp(offset, item.align);
        const viewIndex = bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: item.buffer.byteLength }) - 1;
        views[item.col][item.slot] = viewIndex;
        offset += item.buffer.byteLength;
    });
    const newBin = Buffer.alloc(offset);
    binData.copy(newBin, 0);
    offset = binData.length;
    layout.forEach(item => {
        offset = alignUp(offset, item.align);
        item.buffer.copy(newBin, offset);
        offset += item.buffer.byteLength;
    });
    if (json.buffers && json.buffers[0])
        json.buffers[0].byteLength = newBin.length;

    // 每个带_FEATURE_ID_0的图元挂EXT_mesh_features，指向属性表0
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

    // schema与属性表：STRING列写values+stringOffsets，SCALAR列仅values（componentType在schema中声明）
    const schemaProperties = {};
    columns.forEach(col => {
        const property = { type: col.type };
        if (col.type === 'SCALAR' && col.componentType)
            property.componentType = col.componentType;
        schemaProperties[col.name] = property;
    });
    const tableProperties = {};
    columns.forEach(col => {
        const view = views[col.name];
        tableProperties[col.name] = col.type === 'STRING'
            ? { values: view.values, stringOffsets: view.stringOffsets }
            : { values: view.values };
    });

    json.extensionsUsed = Array.from(new Set(
        [...(json.extensionsUsed || []), 'EXT_mesh_features', 'EXT_structural_metadata']));

    json.extensions = json.extensions || {};
    json.extensions.EXT_structural_metadata = {
        schema: {
            id: 'modelTo3DTiles-feature-schema',
            classes: {
                feature: {
                    properties: schemaProperties,
                },
            },
        },
        propertyTables: [{
            class: 'feature',
            count: featureCount,
            properties: tableProperties,
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
}

/**
 * 取构件属性值：未在meta.json中登记时回退——name列取构件名(唯一键)，
 * elementId取0，其余列取空字符串。
 */
function rowValue(rows, key, columnName) {
    const row = rows[key];
    if (!row || row[columnName] === undefined || row[columnName] === null) {
        if (columnName === 'name') return key;
        if (columnName === 'elementId') return 0;
        return '';
    }
    return row[columnName];
}

/**
 * 按componentType构造定长数值数组（SCALAR列）。
 * @param {Array} values
 * @param {string} componentType EXT_structural_metadata的SCALAR组件类型
 * @returns {TypedArray}
 */
function makeScalarArray(values, componentType) {
    const n = values.length;
    const toNumber = v => ((typeof v === 'number' ? v : Number(v)) || 0);
    switch (componentType) {
        case 'INT8':    { const a = new Int8Array(n);    values.forEach((v, i) => a[i] = toNumber(v)); return a; }
        case 'UINT8':   { const a = new Uint8Array(n);   values.forEach((v, i) => a[i] = toNumber(v)); return a; }
        case 'INT16':   { const a = new Int16Array(n);   values.forEach((v, i) => a[i] = toNumber(v)); return a; }
        case 'UINT16':  { const a = new Uint16Array(n);  values.forEach((v, i) => a[i] = toNumber(v)); return a; }
        case 'INT32':   { const a = new Int32Array(n);   values.forEach((v, i) => a[i] = toNumber(v)); return a; }
        case 'UINT32':  { const a = new Uint32Array(n);  values.forEach((v, i) => a[i] = toNumber(v)); return a; }
        case 'FLOAT32': { const a = new Float32Array(n); values.forEach((v, i) => a[i] = toNumber(v)); return a; }
        case 'FLOAT64': { const a = new Float64Array(n); values.forEach((v, i) => a[i] = toNumber(v)); return a; }
        default: throw new Error('不支持的componentType: ' + componentType);
    }
}

module.exports = { attachFeatureMetadata };
