'use strict';
const sharp = require("sharp");
import { ClampToEdgeWrapping, Texture } from "three";
const defined = require("./defined");

const ATLAS_MAX_SIZE = 2048;
// 网格单元间不留padding（保证页尺寸为2的幂，避免Cesium将NPOT纹理放大到下一2次幂），
// 靠UV向内收缩ATLAS_INSET像素防止相邻贴图渗色
const ATLAS_INSET = 2;

/**
 * 纹理图集优化：将"可合并材质"的baseColor贴图合成为图集页并重映射UV，
 * 使原本仅贴图不同的材质共享同一材质对象，从而被processScene按材质合并，
 * 减少每个瓦片的图元数（draw call）。
 *
 * 参与条件（不满足的材质保持原样）：
 * - MeshStandardMaterial，仅有map贴图，无其他贴图槽位；
 * - 使用该材质的所有mesh都有uv且uv范围在[0,1]内（REPEAT贴图实际未平铺）；
 * - 贴图尺寸不超过图集页上限。
 *
 * @param {import("three").Scene} scene
 * @returns {Promise<{mergedMaterials: number, atlasMaterials: number, pages: number, skippedMaterials: number, skippedTextures: number}>}
 */
async function buildTextureAtlas(scene) {
    // 1. 收集候选材质与贴图使用关系
    const materialInfos = new Map(); // material -> {textures: Set, unsafe: string}
    const meshMaterials = []; // [{mesh, material}]
    scene.traverse(o => {
        if (!o.isMesh || !defined(o.material) || Array.isArray(o.material))
            return;
        const material = o.material;
        meshMaterials.push({ mesh: o, material });
        if (materialInfos.has(material))
            return;
        const info = { textures: new Set(), unsafe: null };
        const otherSlots = ['normalMap', 'emissiveMap', 'aoMap', 'metalnessMap', 'roughnessMap',
            'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'specularMap'];
        if (!defined(material.map))
            info.unsafe = '无baseColor贴图';
        else if (otherSlots.some(slot => defined(material[slot])))
            info.unsafe = '存在其他贴图槽位';
        else if (!getMaterialImageBlob(material.map))
            info.unsafe = '贴图数据不可读';
        materialInfos.set(material, info);
    });
    // uv范围检查：材质被任何超界mesh使用即排除
    const uvRangeCache = new Map(); // geometry -> {minU, maxU, minV, maxV}
    meshMaterials.forEach(({ mesh, material }) => {
        const info = materialInfos.get(material);
        if (info.unsafe || !mesh.geometry.attributes.uv) {
            if (!info.unsafe && !mesh.geometry.attributes.uv)
                info.unsafe = '几何体无uv';
            return;
        }
        let range = uvRangeCache.get(mesh.geometry);
        if (!range) {
            const uv = mesh.geometry.attributes.uv;
            let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
            for (let i = 0; i < uv.count; i++) {
                const u = uv.getX(i), v = uv.getY(i);
                if (u < minU) minU = u;
                if (u > maxU) maxU = u;
                if (v < minV) minV = v;
                if (v > maxV) maxV = v;
            }
            range = { minU, maxU, minV, maxV };
            uvRangeCache.set(mesh.geometry, range);
        }
        const eps = 1e-3;
        if (range.minU < -eps || range.minV < -eps || range.maxU > 1 + eps || range.maxV > 1 + eps)
            info.unsafe = 'uv超出[0,1]（平铺贴图）';
    });

    // 2. 按“除贴图外的材质参数”分组（含材质类型与类型专属参数），组内材质仅map不同
    const groups = new Map(); // key -> {flipY, material, materials: []}
    for (const [material, info] of materialInfos) {
        if (info.unsafe)
            continue;
        const key = [
            material.type,
            material.map.flipY ? 1 : 0,
            material.color.getHexString(),
            material.opacity, material.transparent, material.alphaTest,
            material.side, material.vertexColors, material.flatShading,
            material.emissive ? material.emissive.getHexString() : '',
            defined(material.metalness) ? material.metalness : '',
            defined(material.roughness) ? material.roughness : '',
            defined(material.shininess) ? material.shininess : '',
            material.specular ? material.specular.getHexString() : '',
        ].join('|');
        if (!groups.has(key))
            groups.set(key, { flipY: material.map.flipY, material, materials: [] });
        groups.get(key).materials.push(material);
    }

    // 3. 每组：读取贴图、拼页、生成图集材质与UV映射
    const textureRects = new Map(); // texture -> {material, rect, pageWidth, pageHeight}
    const geometryRects = new WeakMap(); // geometry -> texture（防止共享几何体被重映射到不同rect）
    let pages = 0, atlasMaterials = 0, skippedTextures = 0, resizedTextures = 0, normalizedTextures = 0;
    let mergedMaterials = 0;
    for (const group of groups.values()) {
        if (group.materials.length < 2)
            continue;
        // 组内去重贴图对象并读取图像
        const textures = [];
        group.materials.forEach(m => {
            if (!textures.includes(m.map))
                textures.push(m.map);
        });
        const metas = await Promise.all(textures.map(async texture => {
            const bytes = Buffer.from(await getMaterialImageBlob(texture).arrayBuffer());
            const metadata = await sharp(bytes).metadata();
            let width = metadata.width, height = metadata.height, data = bytes;
            // 非2次幂贴图按最近2次幂重采样后参与图集：
            // 不处理的话Cesium加载时也会将其放大到下一2次幂（画质更差且无法进图集）
            const targetWidth = Math.min(nearestPowerOfTwo(width), ATLAS_MAX_SIZE);
            const targetHeight = Math.min(nearestPowerOfTwo(height), ATLAS_MAX_SIZE);
            if (targetWidth !== width || targetHeight !== height) {
                data = await sharp(bytes)
                    .resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' })
                    .png().toBuffer();
                width = targetWidth;
                height = targetHeight;
                resizedTextures++;
            }
            return { texture, bytes: data, width, height };
        }));
        const packable = metas.filter(m => m.width <= ATLAS_MAX_SIZE && m.height <= ATLAS_MAX_SIZE);
        skippedTextures += metas.length - packable.length;
        if (packable.length < 2)
            continue;
        // 按精确尺寸分桶，桶内以网格铺满2的幂页：页宽高 = 纹理尺寸×每边格数（均为2的幂）
        const sizeClasses = new Map(); // "w×h" -> [meta]
        packable.forEach(meta => {
            const key = meta.width + '×' + meta.height;
            if (!sizeClasses.has(key)) sizeClasses.set(key, []);
            sizeClasses.get(key).push(meta);
        });
        const packedPages = []; // {width, height, items: [{meta, x, y}]}
        for (const metasOfClass of sizeClasses.values()) {
            const cellW = metasOfClass[0].width, cellH = metasOfClass[0].height;
            // 每边格数取2的幂：在满足页尺寸上限的前提下尽量容纳全部
            let cellsPerSide = 1;
            while (cellsPerSide * 2 <= ATLAS_MAX_SIZE / cellW
                && cellsPerSide * 2 <= ATLAS_MAX_SIZE / cellH
                && cellsPerSide * cellsPerSide < metasOfClass.length) {
                cellsPerSide *= 2;
            }
            const capacity = cellsPerSide * cellsPerSide;
            const pageCount = Math.ceil(metasOfClass.length / capacity);
            for (let p = 0; p < pageCount; p++) {
                const page = { width: cellW * cellsPerSide, height: cellH * cellsPerSide, items: [] };
                metasOfClass.slice(p * capacity, (p + 1) * capacity).forEach((meta, i) => {
                    page.items.push({ meta, x: (i % cellsPerSide) * cellW, y: Math.floor(i / cellsPerSide) * cellH });
                });
                packedPages.push(page);
            }
        }
        // 生成每页的图集材质与贴图
        for (const page of packedPages) {
            const pageWidth = page.width, pageHeight = page.height;
            const compositeInputs = page.items.map(item => ({ input: item.meta.bytes, left: item.x, top: item.y }));
            // 源全为jpg且材质不透明时页输出jpeg（体积远小于无损png），否则png保留alpha
            const needAlpha = group.material.transparent
                || page.items.some(item => item.meta.texture.image.mimeType === 'image/png');
            const mimeType = needAlpha ? 'image/png' : 'image/jpeg';
            let pageBytes;
            if (needAlpha) {
                pageBytes = await sharp({
                    create: { width: pageWidth, height: pageHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
                }).composite(compositeInputs).png({ compressionLevel: 9 }).toBuffer();
            } else {
                pageBytes = await sharp({
                    create: { width: pageWidth, height: pageHeight, channels: 3, background: { r: 0, g: 0, b: 0 } },
                }).composite(compositeInputs).jpeg({ quality: 90 }).toBuffer();
            }
            const atlasTexture = new Texture({
                name: 'atlas-' + (pages + 1),
                data: new Blob([pageBytes], { type: mimeType }),
                mimeType: mimeType,
            });
            atlasTexture.name = 'atlas-' + (pages + 1);
            atlasTexture.wrapS = atlasTexture.wrapT = ClampToEdgeWrapping;
            atlasTexture.flipY = group.flipY;
            atlasTexture.userData.mimeType = mimeType;
            // 克隆组内源材质并替换贴图：与源材质同类型同参数，后续材质标准化流程照常处理
            const source = group.material;
            const atlasMaterial = source.clone();
            atlasMaterial.name = source.name ? source.name + '-atlas' : 'atlas-' + (pages + 1);
            atlasMaterial.map = atlasTexture;
            atlasMaterials++;
            pages++;
            page.items.forEach(item => {
                textureRects.set(item.meta.texture, {
                    material: atlasMaterial,
                    rect: { x: item.x, y: item.y, width: item.meta.width, height: item.meta.height },
                    pageWidth, pageHeight,
                    flipY: group.flipY,
                });
            });
        }
        mergedMaterials += group.materials.length;
    }

    // 4. 替换材质并重映射UV
    let remappedMeshes = 0;
    meshMaterials.forEach(({ mesh, material }) => {
        const entry = materialInfos.get(material);
        if (entry && entry.unsafe)
            return;
        const rect = textureRects.get(material.map);
        if (!rect)
            return;
        mesh.material = rect.material;
        // 共享几何体可能被不同rect的mesh使用：冲突时克隆
        if (defined(geometryRects.get(mesh.geometry)) && geometryRects.get(mesh.geometry) !== material.map) {
            mesh.geometry = mesh.geometry.clone();
        }
        geometryRects.set(mesh.geometry, material.map);
        remapGeometryUVs(mesh.geometry, rect);
        remappedMeshes++;
    });

    // 5. 未进入图集的贴图（UV平铺被排除、其他贴图槽位等）也归一化为2的幂，
    //    否则Cesium加载时会将NPOT纹理强制放大到下一2次幂（画质与显存双输）
    const normalized = await normalizeTexturePowers(scene, textureRects);
    normalizedTextures = normalized.count;

    const skippedMaterials = [...materialInfos.values()].filter(i => i.unsafe).length;
    return {
        mergedMaterials,
        atlasMaterials,
        pages,
        skippedMaterials,
        skippedTextures,
        resizedTextures,
        normalizedTextures,
        remappedMeshes,
    };
};

/**
 * 将场景内所有贴图槽位的非2的幂贴图重采样至最近2的幂（上限2048）。
 * Cesium加载NPOT纹理时会强制放大到下一2次幂，提前重采样画质更好且显存可控。
 * @param {import("three").Scene} scene
 * @param {Map} [excludeTextures] 已进入图集的贴图（无需再处理）
 * @returns {Promise<{count: number}>} 重采样的贴图数量
 */
async function normalizeTexturePowers(scene, excludeTextures) {
    let count = 0;
    const seen = new Set();
    const tasks = [];
    scene.traverse(o => {
        if (!o.isMesh || !defined(o.material))
            return;
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        materials.forEach(material => {
            ['map', 'normalMap', 'emissiveMap', 'aoMap', 'specularMap', 'bumpMap',
                'alphaMap', 'metalnessMap', 'roughnessMap'].forEach(slot => {
                const texture = material[slot];
                if (!defined(texture) || seen.has(texture)
                    || (excludeTextures && excludeTextures.has(texture)))
                    return;
                seen.add(texture);
                tasks.push((async () => {
                    const blob = getMaterialImageBlob(texture);
                    if (!blob)
                        return;
                    const bytes = Buffer.from(await blob.arrayBuffer());
                    const metadata = await sharp(bytes).metadata();
                    const width = Math.min(nearestPowerOfTwo(metadata.width), ATLAS_MAX_SIZE);
                    const height = Math.min(nearestPowerOfTwo(metadata.height), ATLAS_MAX_SIZE);
                    if (width === metadata.width && height === metadata.height)
                        return;
                    const resized = await sharp(bytes)
                        .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
                        .png().toBuffer();
                    texture.image = {
                        name: texture.name || '',
                        data: new Blob([resized], { type: 'image/png' }),
                        mimeType: 'image/png',
                    };
                    texture.userData.mimeType = 'image/png';
                    count++;
                })());
            });
        });
    });
    await Promise.all(tasks);
    return { count };
};

// 取材质贴图的图像Blob：兼容两种image形状
// - {name, data: Blob, mimeType}（obj/gltf加载路径的包装形状）
// - Blob本身（FBXLoader直接以Blob作为image）
function getMaterialImageBlob(texture) {
    const image = texture.image;
    if (!defined(image))
        return null;
    if (defined(image.data) && typeof image.data.arrayBuffer === 'function')
        return image.data;
    if (typeof image.arrayBuffer === 'function')
        return image;
    return null;
};

// 最近的2次幂（≥1）
function nearestPowerOfTwo(n) {
    return Math.max(1, Math.pow(2, Math.round(Math.log2(n))));
};

// 将几何体uv重映射到图集网格单元（向内收缩ATLAS_INSET像素防相邻贴图渗色；flipY材质在单元内翻转v）
function remapGeometryUVs(geometry, rect) {
    const uv = geometry.attributes.uv;
    const { x, y, width, height } = rect.rect;
    const inset = Math.min(ATLAS_INSET, Math.floor(Math.min(width, height) / 4));
    const uScale = (width - inset * 2), vScale = (height - inset * 2);
    const array = uv.array;
    for (let i = 0; i < uv.count; i++) {
        const u = array[i * 2], v = array[i * 2 + 1];
        array[i * 2] = (x + inset + u * uScale) / rect.pageWidth;
        const vv = rect.flipY ? (1 - v) : v;
        array[i * 2 + 1] = (y + inset + vv * vScale) / rect.pageHeight;
    }
    uv.needsUpdate = true;
};

module.exports = { buildTextureAtlas, normalizeTexturePowers };
