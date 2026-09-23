'use strict';
const fsExtra = require("fs-extra");

/**
 * 解析BIM语义sidecar(.metadata)，产出EXT_structural_metadata属性表描述符：
 *  - columns: 固定列 name/elementId/category/family/type/storey + parameters(JSON字符串列)
 *  - rows:    以构件唯一键(Revit UniqueId，即glTF节点名/节点extras.uniqueId)为键的属性行
 * 转换器的 attachFeatureMetadata 据此将瓦片内 featureId 映射为多列属性表。
 *
 * .metadata 由 revitToGltf 插件的 MetadataWriter 生成：Elements 为数组，每个元素
 * Key = Revit UniqueId（与 glTF 节点名一一对应）。参数集不按列展开，而是序列化为
 * 单个JSON字符串列，避免个别构件参数键爆炸导致属性表过宽。
 *
 * @param {string} metadataPath .metadata路径
 * @returns {{columns: Array<{name:string, type:string, componentType?:string}>, rows: Object}}
 */
function loadInputMetadata(metadataPath) {
    const meta = JSON.parse(fsExtra.readFileSync(metadataPath, 'utf8'));
    const elements = meta && meta.Elements;
    if (!Array.isArray(elements)) {
        throw new Error('元数据文件缺少 Elements 数组：请使用 revitToGltf 导出的 .metadata（旧版 meta.json 格式已不再支持）');
    }

    const columns = [
        { name: 'name', type: 'STRING' },
        { name: 'elementId', type: 'SCALAR', componentType: 'INT32' },
        { name: 'category', type: 'STRING' },
        { name: 'family', type: 'STRING' },
        { name: 'type', type: 'STRING' },
        { name: 'storey', type: 'STRING' },
        { name: 'parameters', type: 'STRING' },
    ];

    const rows = {};
    elements.forEach(el => {
        const key = el && (el.Key !== undefined ? el.Key : el.key);
        if (!key)
            return;
        rows[key] = {
            name: stringValue(el.Name, key),
            elementId: Number.isFinite(el.ElementId) ? el.ElementId : 0,
            category: stringValue(el.Category),
            family: stringValue(el.Family),
            type: stringValue(el.type),
            storey: stringValue(el.Level),
            parameters: (el.Parameters && typeof el.Parameters === 'object')
                ? JSON.stringify(el.Parameters) : '',
        };
    });

    if (Object.keys(rows).length === 0)
        throw new Error('元数据文件中没有可用的构件条目');

    return { columns, rows };
}

function stringValue(value, fallback) {
    if (value === undefined || value === null)
        return fallback === undefined ? '' : fallback;
    return String(value);
}

module.exports = { loadInputMetadata };
