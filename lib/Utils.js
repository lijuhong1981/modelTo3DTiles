import { BufferGeometry } from "three";
import { mergeGeometries as mergeGeometriesImpl } from "three/examples/jsm/utils/BufferGeometryUtils.js";
const defined = require("./defined");

/**
 * 只保留几何体的position属性，移除所有非position属性
 * @param {BufferGeometry[]} geometries
 */
function keepOnlyPositionAttribute(geometries) {
    if (geometries.length <= 1) return;

    // 如果几何体具有索引，则转换为非索引几何体
    for (let i = 0; i < geometries.length; i++) {
        const geometry = geometries[i];
        if (defined(geometry.index))
            geometries[i] = geometry.toNonIndexed();
    }
    // 移除非position属性
    geometries.forEach(geometry => {
        for (const attrName in geometry.attributes) {
            if (attrName !== 'position') {
                geometry.deleteAttribute(attrName);
            }
        }
    });
};
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
    geometries.forEach(geometry => {
        for (const attrName in geometry.attributes) {
            // 如果不包含该属性，则删除
            if (!normalizeAttributes.has(attrName)) {
                console.log(`删除几何体${geometry.uuid}的属性${attrName}。`);
                geometry.deleteAttribute(attrName);
            }
        }
    });
};
/**
 * 合并几何体
 * @param {BufferGeometry[]} geometries
 * @param {boolean} onlyPosition 是否只保留position属性
 * @returns {BufferGeometry}
 */
function mergeGeometries(geometries, onlyPosition = false) {
    if (geometries.length <= 1) return geometries[0];
    if (onlyPosition) keepOnlyPositionAttribute(geometries);
    else normalizeGeometryAttributes(geometries);
    const result = mergeGeometriesImpl(geometries);
    result.isMerged = true; //标记为合并几何体
    return result;
};

module.exports = { normalizeGeometryAttributes, keepOnlyPositionAttribute, mergeGeometries };