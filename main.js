#!/usr/bin/env node
'use strict';
const path = require("path");
const v8 = require('v8');
const yargs = require("yargs");
const defined = require("./lib/defined");
const { loadInputMetadata } = require("./lib/inputMetadata");
const modelTo3DTiles = require("./dist/modelTo3DTiles");

// console.log(__filename, __dirname);
console.log('NODE_OPTIONS:', process.env.NODE_OPTIONS);
console.log('execArgv:', process.execArgv);
// console.log('argv:', process.argv);
// console.log('execPath:', process.execPath);

const argv = yargs
    .usage("Usage: $0 -i inputPath")
    .help("h")
    .alias("h", "help")
    .alias("v", "version")
    .options({
        input: {
            alias: "i",
            describe: "输入模型路径,支持obj、gltf、glb、fbx模型。",
            type: "string",
            demandOption: true,
            coerce: function (p) {
                if (!defined(p)) {
                    return undefined;
                }
                if (p.length === 0) {
                    throw new Error("Input path must be a file name");
                }
                return path.resolve(p);
            },
        },
        output: {
            alias: "o",
            describe: "设置模型输出目录,不填则在模型文件目录下自动创建一个3dtiles目录。",
            type: "string",
        },
        metadata: {
            alias: "md",
            describe: "输入BIM语义sidecar(.metadata),将构件的BIM属性(名称/元素ID/类别/族/类型/楼层/参数集)写入瓦片内EXT_structural_metadata多列属性表,支持加载端按构件查询与按楼层/类别过滤。.metadata由revitToGltf插件导出,其Elements数组的Key字段与glTF节点extras.uniqueId一一对应。",
            type: "string",
            coerce: function (p) {
                if (!defined(p)) {
                    return undefined;
                }
                if (p.length === 0) {
                    throw new Error("Metadata path must be a file name");
                }
                return path.resolve(p);
            },
        },
        inputUpAxis: {
            alias: "iua",
            describe: "设置输入模型的向上坐标轴。",
            choices: ["X", "Y", "Z", "-X", "-Y", "-Z"],
            type: "string",
        },
        // outputUpAxis: {
        //     alias: "oua",
        //     describe: "设置转换后模型的向上坐标轴。",
        //     choices: ["X", "Y", "Z"],
        //     type: "string",
        //     default: "Y",
        // },
        rotation: {
            alias: "r",
            describe: "手动设置模型旋转角度,格式为[x,y,z],单位为度。坐标轴朝向已自动归一化,仅在模型本身存在轴向以外的偏转(如偏离正北)时设置。",
            type: "string",
        },
        lngLatAlt: {
            alias: "lla",
            describe: "设置模型经度、纬度、海拔高度,格式为[longitude,latitude,altitude],高度单位为米。",
            type: "string",
            default: "116.4074,39.9042,0",
        },
        correctCenter: {
            alias: "cc",
            describe: "自动修正模型锚点至模型包围盒中心点,修正后经纬度对应包围盒中心。",
            type: "boolean",
            default: true,
        },
        b3dm: {
            describe: "以b3dm容器输出瓦片(3D Tiles经典格式,兼容传统前端);关闭则输出glb瓦片(3D Tiles 1.1)。",
            type: "boolean",
            default: true,
        },
        split: {
            alias: "s",
            describe: "设置瓦片拆分方式:material按材质顺序装填(默认,适合单精度精细模型,draw call恒为材质数、体积最小、加载最快);spatial按空间递归切分并生成LOD层级瓦片(远景渲染粗层、近景refine细层,适合大体量场景的漫游剔除,体积约为material的4倍,同精度模型下收益有限,待多精度简化引入后完全兑现)。",
            choices: ["spatial", "material"],
            type: "string",
            default: "material",
        },
        instancing: {
            describe: "保留glTF输入的实例化网格(EXT_mesh_gpu_instancing+EXT_instance_features):同几何多构件(如族实例)只存一份几何+每实例矩阵表,体积与转换内存大幅下降,构件拾取/显隐不受影响;仅material拆分模式生效,spatial自动回退为展开。需Cesium 1.107+加载。",
            type: "boolean",
            default: true,
        },
        textureAtlas: {
            alias: "ta",
            describe: "启用纹理图集优化:可合并材质的贴图按尺寸分桶合成2的幂图集页并重映射UV,减少材质数与draw call;非2的幂贴图重采样至最近2的幂。仅baseColor贴图、UV在[0,1]内的材质参与合并。",
            type: "boolean",
            default: true,
        },
        resampleTextures: {
            alias: "rst",
            describe: "将非2的幂贴图重采样至最近2的幂(含全部贴图槽位),避免Cesium将NPOT纹理放大到下一2次幂导致显存膨胀;启用textureAtlas时无需单独开启。",
            type: "boolean",
            default: true,
        },
        draco: {
            alias: "d",
            describe: "启用Draco几何压缩(KHR_draco_mesh_compression),瓦片体积大幅下降,加载端由Cesium自动解码;含featureId属性,与构件拾取兼容。",
            type: "boolean",
            default: true,
        },
        mergePrimitive: {
            alias: "mp",
            describe: "设置是否合并材质相同的网格图元。",
            type: "boolean",
            default: true,
        },
        tileSize: {
            alias: "ts",
            describe: "设置期望的单个瓦片存储容量,单位mb。",
            type: "number",
            default: 10,
        },
        clampToGround: {
            alias: "ctg",
            describe: "设置模型是否自动贴地,为true时lngLatAlt属性下高度失效。",
            type: "boolean",
            default: true,
        },
        noneTransform: {
            alias: "nt",
            describe: "是否不设置模型变换矩阵,为true时lngLatAlt、clampToGround等属性失效。",
            type: "boolean",
            default: false,
        },
        checkTransparency: {
            describe:
                "Do a more exhaustive check for texture transparency by looking at the alpha channel of each pixel. By default textures are considered to be opaque.",
            type: "boolean",
            default: false,
        },
        packOcclusion: {
            describe:
                "Pack the occlusion texture in the red channel of metallic-roughness texture.",
            type: "boolean",
            default: false,
        },
        metallicRoughness: {
            describe:
                "The values in the .mtl file are already metallic-roughness PBR values and no conversion step should be applied. Metallic is stored in the Ks and map_Ks slots and roughness is stored in the Ns and map_Ns slots.",
            type: "boolean",
            default: true,
        },
        specularGlossiness: {
            describe:
                "The values in the .mtl file are already specular-glossiness PBR values and no conversion step should be applied. Specular is stored in the Ks and map_Ks slots and glossiness is stored in the Ns and map_Ns slots. The glTF will be saved with the KHR_materials_pbrSpecularGlossiness extension.",
            type: "boolean",
            default: false,
        },
        unlit: {
            describe:
                "The glTF will be saved with the KHR_materials_unlit extension.",
            type: "boolean",
            default: false,
        },
    })
    .parse(process.argv);

// console.log("input argv:", argv);
// console.log(process.memoryUsage());
console.log('V8堆内存参数:', v8.getHeapStatistics().heap_size_limit / (1024 * 1024) + 'MB');

const inputPath = argv.input;
const inputDirectory = path.dirname(inputPath);
const extension = path.extname(inputPath).toLowerCase();
const format = extension.substring(1);
let outputDirectory = argv.output;
if (!defined(outputDirectory)) {
    outputDirectory = path.join(inputDirectory, "3dtiles");
}
const inputUpAxis = argv.inputUpAxis;
let rotation;
if (defined(argv.rotation)) {
    const rotationArray = argv.rotation.split(",");
    rotation = {
        x: parseFloat(rotationArray[0]),
        y: parseFloat(rotationArray[1]),
        z: parseFloat(rotationArray[2]),
    };
}
let lngLatAlt;
if (defined(argv.lngLatAlt)) {
    const lngLatAltArray = argv.lngLatAlt.split(",");
    lngLatAlt = {
        longitude: parseFloat(lngLatAltArray[0]),
        latitude: parseFloat(lngLatAltArray[1]),
        altitude: parseFloat(lngLatAltArray[2]),
    };
}

const options = {
    inputDirectory,
    extension,
    format,
    outputDirectory,
    inputUpAxis,
    // outputUpAxis: argv.outputUpAxis,
    rotation,
    lngLatAlt,
    correctCenter: argv.correctCenter,
    b3dm: argv.b3dm,
    split: argv.split,
    instancing: argv.instancing,
    textureAtlas: argv.textureAtlas,
    resampleTextures: argv.resampleTextures,
    draco: argv.draco,
    mergePrimitive: argv.mergePrimitive,
    tileSize: argv.tileSize,
    clampToGround: argv.clampToGround,
    noneTransform: argv.noneTransform,
    checkTransparency: argv.checkTransparency,
    packOcclusion: argv.packOcclusion,
    metallicRoughness: argv.metallicRoughness,
    specularGlossiness: argv.specularGlossiness,
    unlit: argv.unlit,
};

// 解析BIM语义sidecar为属性表描述符，随瓦片写入EXT_structural_metadata多列属性表
if (defined(argv.metadata)) {
    options.metadata = loadInputMetadata(argv.metadata);
    console.log('加载元数据: ' + argv.metadata);
}

// 各格式加载器已将模型统一归一化为Y-up朝向（glTF规范为Y-up；FBX按文件声明的UpAxis转换；obj按--inputUpAxis转换，默认Z-up），
// GLB内容按Y-up导出，Cesium渲染时自动转换为Z-up，因此默认无需旋转；--rotation仅作为手动覆盖。
modelTo3DTiles(inputPath, options);