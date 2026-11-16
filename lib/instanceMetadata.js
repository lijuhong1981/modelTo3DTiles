'use strict';
const { Matrix4, Quaternion, Vector3 } = require("three");

/**
 * 为瓦片GLB内的实例化组节点注入 EXT_mesh_gpu_instancing 与 EXT_instance_features:
 *  - 按节点名找到代表网格对应的glTF节点(GLTFExporter以object.name为节点名)
 *  - 每实例矩阵分解为TRANSLATION/ROTATION/SCALE实例属性(VVS 2027行主序f32)
 *  - userData.instanceFeatureIds(瓦片内featureId)写为_FEATURE_ID_0实例属性(uint16)
 *  - 节点声明EXT_instance_features,attribute:0指向_FEATURE_ID_0,propertyTable:0
 *    指向attachFeatureMetadata写入的属性表(实例名即构件键,行序与tile.features一致)
 *
 * 需在Draco压缩与贴图外置之后、attachFeatureMetadata之前调用(追加区偏移按当次
 * BIN长度计算,两次追加串行递增不冲突)。spike验证:Cesium 1.137实测该组合
 * 渲染/逐实例拾取/显隐/染色均可用,glTF 1.1瓦片与b3dm壳内嵌均可。
 * 就地修改解析后的GLB工作对象(无序列化,由writeScene统一写出)。
 *
 * @param {{json: object, bin: Buffer|null}} parts glbParts.parseGlbParts产物(就地修改)
 * @param {import("three").Mesh[]} meshes 场景中的实例化组代表网格(userData.instances/instanceFeatureIds)
 */
function applyInjectInstanceMetadata(parts, meshes) {
    if (!meshes || meshes.length === 0)
        return;
    const binData = parts.bin;
    if (!binData)
        return;
    const json = parts.json;
    const bufferViews = json.bufferViews || (json.bufferViews = []);
    const accessors = json.accessors || (json.accessors = []);
    const nodes = json.nodes || [];
    // 节点名索引(代表网格名由processGltfDoc全局计数生成,瓦片内唯一)
    const nodeByName = new Map();
    nodes.forEach((node, i) => { if (node.name) nodeByName.set(node.name, i); });

    const alignUp = (n, a) => (n + a - 1) & ~(a - 1);
    let offset = binData.length;
    const appended = []; // {view, buffer} 按追加顺序
    function appendView(buffer) {
        offset = alignUp(offset, 4);
        const view = { buffer: 0, byteOffset: offset, byteLength: buffer.byteLength };
        bufferViews.push(view);
        appended.push({ view, buffer });
        offset += buffer.byteLength;
        return bufferViews.length - 1;
    }
    function minMaxOf(stride, array) {
        const min = new Array(stride).fill(Infinity), max = new Array(stride).fill(-Infinity);
        for (let i = 0; i < array.length; i += stride) {
            for (let k = 0; k < stride; k++) {
                if (array[i + k] < min[k]) min[k] = array[i + k];
                if (array[i + k] > max[k]) max[k] = array[i + k];
            }
        }
        return [min, max];
    }

    let injected = 0;
    const matrix = new Matrix4(), position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3();
    meshes.forEach(mesh => {
        const nodeIndex = nodeByName.get(mesh.name);
        if (nodeIndex === undefined) {
            console.warn('实例化组节点未在导出GLB中找到: ' + mesh.name);
            return;
        }
        const instances = mesh.userData.instances;
        const featureIds = mesh.userData.instanceFeatureIds;
        if (!instances || !featureIds || instances.length === 0)
            return;
        const count = instances.length;
        const translations = new Float32Array(count * 3);
        const rotations = new Float32Array(count * 4);
        const scales = new Float32Array(count * 3);
        const featureIdArray = new Uint16Array(count);
        // 逐循环求最大featureId:Math.max(...featureIds)在万级实例组会因参数展开爆栈
        let maxFeatureId = 0;
        for (let i = 0; i < count; i++) {
            matrix.copy(instances[i].matrix).decompose(position, quaternion, scale);
            position.toArray(translations, i * 3);
            quaternion.toArray(rotations, i * 4);
            scale.toArray(scales, i * 3);
            featureIdArray[i] = featureIds[i];
            if (featureIds[i] > maxFeatureId) maxFeatureId = featureIds[i];
        }

        const accTranslation = accessors.push({
            bufferView: appendView(Buffer.from(translations.buffer)),
            componentType: 5126, count, type: 'VEC3',
            min: minMaxOf(3, translations)[0], max: minMaxOf(3, translations)[1],
        }) - 1;
        const accRotation = accessors.push({
            bufferView: appendView(Buffer.from(rotations.buffer)),
            componentType: 5126, count, type: 'VEC4',
        }) - 1;
        const accScale = accessors.push({
            bufferView: appendView(Buffer.from(scales.buffer)),
            componentType: 5126, count, type: 'VEC3',
            min: minMaxOf(3, scales)[0], max: minMaxOf(3, scales)[1],
        }) - 1;
        const accFeatureId = accessors.push({
            bufferView: appendView(Buffer.from(featureIdArray.buffer)),
            componentType: 5123, count, type: 'SCALAR',
        }) - 1;

        const node = nodes[nodeIndex];
        node.extensions = node.extensions || {};
        node.extensions.EXT_mesh_gpu_instancing = {
            attributes: {
                TRANSLATION: accTranslation,
                ROTATION: accRotation,
                SCALE: accScale,
                _FEATURE_ID_0: accFeatureId,
            },
        };
        node.extensions.EXT_instance_features = {
            featureIds: [{
                featureCount: maxFeatureId + 1,
                attribute: 0,
                propertyTable: 0,
            }],
        };
        injected++;
    });
    if (injected === 0)
        return;

    if (json.buffers && json.buffers[0])
        json.buffers[0].byteLength = offset;
    json.extensionsUsed = Array.from(new Set([...(json.extensionsUsed || []),
        'EXT_mesh_gpu_instancing', 'EXT_instance_features']));

    // 追加区写入重建的BIN(补齐8字节对齐,与独立序列化后下游所见长度一致)
    const pad8 = n => (n + 7) & ~7;
    const newBin = Buffer.alloc(pad8(offset));
    binData.copy(newBin, 0);
    appended.forEach(({ view, buffer }) => buffer.copy(newBin, view.byteOffset));
    parts.bin = newBin;
}

module.exports = { applyInjectInstanceMetadata };
