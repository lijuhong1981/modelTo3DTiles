'use strict';
const fsExtra = require("fs-extra");

/**
 * 解析BIM语义sidecar(meta.json)，产出EXT_structural_metadata属性表描述符：
 *  - columns: 固定列 name/elementId/category/type/storey + parameters(JSON字符串列)
 *  - rows:    以构件唯一键(Revit UniqueId，即glTF节点名)为键的属性行
 * 转换器的 attachFeatureMetadata 据此将瓦片内 featureId 映射为多列属性表。
 *
 * meta.json 由 revitTo3DTiles 插件生成，其 elements 的键与 glTF 节点名
 * （GltfWriter 以 Revit UniqueId 为节点名）一一对应。参数集不按列展开，
 * 而是序列化为单个JSON字符串列，避免个别构件参数键爆炸导致属性表过宽。
 *
 * @param {string} metadataPath meta.json路径
 * @returns {{columns: Array<{name:string, type:string, componentType?:string}>, rows: Object}}
 */
function loadInputMetadata(metadataPath) {
    const meta = JSON.parse(fsExtra.readFileSync(metadataPath, 'utf8'));
    const elements = (meta && meta.elements) || {};

    const columns = [
        { name: 'name', type: 'STRING' },
        { name: 'elementId', type: 'SCALAR', componentType: 'INT32' },
        { name: 'category', type: 'STRING' },
        { name: 'type', type: 'STRING' },
        { name: 'storey', type: 'STRING' },
        { name: 'parameters', type: 'STRING' },
    ];

    const rows = {};
    Object.keys(elements).forEach(key => {
        const el = elements[key] || {};
        rows[key] = {
            name: stringValue(el.name, key),
            elementId: Number.isFinite(el.elementId) ? el.elementId : 0,
            category: stringValue(el.category),
            type: stringValue(el.type),
            storey: stringValue(el.storey),
            parameters: (el.parameters && typeof el.parameters === 'object')
                ? JSON.stringify(el.parameters) : '',
        };
    });

    return { columns, rows };
}

function stringValue(value, fallback) {
    if (value === undefined || value === null)
        return fallback === undefined ? '' : fallback;
    return String(value);
}

module.exports = { loadInputMetadata };
