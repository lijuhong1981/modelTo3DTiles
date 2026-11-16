import { BufferGeometry } from "three";
import { mergeGeometries as mergeGeometriesImpl } from "three/examples/jsm/utils/BufferGeometryUtils.js";
const defined = require("./defined");

/**
 * 标准化几何体属性，移除所有非position、normal、uv属性
 * @param {BufferGeometry[]} geometries
*/
function normalizeGeometryAttributes(geometries) {
    if (geometries.length <= 1) return;

    // 如果几何体具有索引，则转换为非索引几何体
    for (let i = 0; i < geometries.length; i++) {
        const geometry = geometries[i];
        if (defined(geometry.index))
            geometries[i] = geometry.toNonIndexed();
    }

    const normalizeAttributes = new Set(['position', 'normal', 'uv']);
    // 按属性名聚合计数，最后输出一条统计（逐几何逐属性打印在大模型下会产生上万行日志）
    const removedCounts = new Map();
    geometries.forEach(geometry => {
        for (const attrName in geometry.attributes) {
            // 如果不包含该属性，则删除
            if (!normalizeAttributes.has(attrName)) {
                removedCounts.set(attrName, (removedCounts.get(attrName) || 0) + 1);
                geometry.deleteAttribute(attrName);
            }
        }
    });
    if (removedCounts.size > 0) {
        const summary = [...removedCounts.entries()].map(([name, count]) => `${name}×${count}`).join(', ');
        console.log(`合并几何时移除不参与合并的属性: ${summary}`);
    }
};
/**
 * 合并几何体
 * @param {BufferGeometry[]} geometries
 * @returns {BufferGeometry}
 */
function mergeGeometries(geometries) {
    if (geometries.length <= 1) return geometries[0];
    normalizeGeometryAttributes(geometries);
    const result = mergeGeometriesImpl(geometries);
    result.isMerged = true; //标记为合并几何体
    return result;
};

module.exports = { normalizeGeometryAttributes, mergeGeometries };
