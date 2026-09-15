# modelTo3DTiles

[![npm version](https://img.shields.io/npm/v/@lijuhong1981%2Fmodelto3dtiles)](https://www.npmjs.com/package/@lijuhong1981/modelto3dtiles)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

将普通精细模型转换为 [3D Tiles](https://github.com/CesiumGS/3d-tiles) 的命令行工具,可在 [Cesium](https://cesium.com/platform/cesiumjs/) 或 [threejs](https://threejs.org/) 中加载,支持 `.obj`、`.fbx`、`.gltf`、`.glb` 格式。

## 特性

- **多格式输入**:obj(含 mtl/贴图)、fbx(自动读取文件声明的 UpAxis)、gltf/glb(含 Draco 压缩输入)
- **坐标自动归一化**:向上轴自动转换为 glTF 规范的 Y-up,锚点自动修正至模型包围盒中心,支持经纬度定位与自动贴地
- **空间切分**:瓦片按空间递归切分聚集,视锥剔除按瓦片生效
- **纹理图集**:可合并材质的贴图合成 2 的幂图集页并重映射 UV,显著减少 draw call
- **贴图外置去重**:瓦片间共享贴图文件(按内容哈希),避免重复下载与显存占用
- **Draco 几何压缩**:瓦片几何体积压缩约 90%,加载端由 Cesium 自动解码
- **构件级拾取**:输出附带 `EXT_mesh_features` / `EXT_structural_metadata` 扩展,Cesium 中可按构件(如单个座椅)拾取、查询、显隐、着色
- **b3dm / glb 双格式**:默认 b3dm(3D Tiles 经典格式),可切换 glb 瓦片(3D Tiles 1.1)

## 安装

**npm 安装**(需 Node.js ≥ 18):

```bash
# 全局安装后使用 modelTo3DTiles 命令
npm install -g @lijuhong1981/modelto3dtiles

# 或免安装直接运行
npx @lijuhong1981/modelto3dtiles -i ./model.obj
```

**exe 免安装**(Windows):从 [Releases](../../releases) 下载 `modelTo3DTiles.exe`。

**从源码运行**:

```bash
git clone https://github.com/lijuhong1981/modelTo3DTiles.git
cd modelTo3DTiles
npm install
npm run build:esbuild
```

## 使用

npm 全局安装或 exe 方式下,直接使用 `modelTo3DTiles` 命令:

```bash
# 基本转换(obj/fbx/gltf/glb 均可),默认已启用纹理图集与Draco压缩
modelTo3DTiles -i ./model.obj

# 指定输出目录与经纬度(默认 116.4074,39.9042)
modelTo3DTiles -i ./model.fbx -o ./output --lla 106.55,29.56,0

# 追求最高画质、加载端零解码开销:关闭Draco压缩与纹理图集
modelTo3DTiles -i ./model.gltf -o ./output --no-draco --no-ta
```

从源码运行时,将命令换为 `node main.js`,参数完全相同:

```bash
node main.js -i ./model.obj
```

输入模型向上坐标轴自动识别与转换:obj 默认按 Z-up 处理(可用 `--inputUpAxis` 指定),fbx 读取文件 GlobalSettings 声明的 UpAxis,gltf/glb 按规范固定 Y-up。

## 命令参数

|参数名称|别名|描述|类型|默认值|是否必须|
|:---:|:---:|:---:|:---:|:---:|:---:|
|--help|-h|显示帮助|Boolean||否|
|--version|-v|显示版本号|Boolean||否|
|--input|-i|输入模型路径|String||是|
|--output|-o|模型输出目录,<br>不填则在模型文件目录下自动创建一个3dtiles目录。|String||否|
|--inputUpAxis|--iua|设置输入模型的向上坐标轴,<br>[可选值:X,Y,Z,-X,-Y,-Z]<br>obj默认按Z-up处理并自动转换,<br>fbx默认读取文件GlobalSettings声明的UpAxis,<br>gltf/glb按规范固定为Y-up。|String|见描述|否|
|--rotation|-r|手动设置模型旋转角度,<br>格式为[x,y,z],单位为度。<br>坐标轴朝向已自动归一化,<br>仅当模型存在轴向以外的偏转<br>(如偏离正北)时才需要设置。|String||否|
|--lngLatAlt|--lla|设置模型经度、纬度、海拔高度,<br>格式为[longitude,latitude,altitude],<br>高度单位为米。|String|116.4074,<br>39.9042,0|否|
|--correctCenter|--cc|自动修正模型锚点至模型<br>包围盒中心点,<br>修正后经纬度对应包围盒中心。|Boolean|true|否|
|--b3dm||以b3dm容器输出瓦片,<br>3D Tiles经典格式,兼容传统前端;<br>关闭则输出glTF瓦片(3D Tiles 1.1)。|Boolean|true|否|
|--split||设置瓦片拆分方式,<br>[可选值:spatial,material]<br>spatial按空间递归切分瓦片,<br>空间聚集便于视锥剔除;<br>material按材质顺序装填,<br>适合单体小模型<br>(不做几何切分、保留索引几何)。|String|spatial|否|
|--textureAtlas|--ta|启用纹理图集优化:<br>将可合并材质的贴图按尺寸分桶<br>合成2的幂网格图集页并重映射UV,<br>减少材质数与draw call;<br>非2的幂贴图重采样至最近2的幂。<br>仅baseColor贴图、UV在[0,1]内的<br>材质参与合并。|Boolean|true|否|
|--resampleTextures|-rst|将非2的幂贴图重采样至<br>最近2的幂(含全部贴图槽位),<br>避免Cesium将NPOT纹理放大到<br>下一2次幂导致显存膨胀;<br>启用textureAtlas时无需单独开启。|Boolean|true|否|
|--draco|-d|启用Draco几何压缩<br>(KHR_draco_mesh_compression),<br>瓦片体积大幅下降,<br>加载端由Cesium自动解码;<br>含featureId属性,<br>与构件拾取兼容。|Boolean|true|否|
|--mergePrimitive|-mp|设置是否合并材质相同的网格图元。|Boolean|true|否|
|--tileSize|-ts|设置期望的单个瓦片存储容量,<br>单位mb。|Number|10|否|
|--clampToGround|--ctg|设置模型是否自动贴地,<br>为true时altitude属性失效。|Boolean|true|否|
|--noneTransform|--nt|是否不设置模型变换矩阵,<br>为true时lngLatAlt、clampToGround等<br>属性失效。|Boolean|false|否|

另有面向 obj 材质转换的高级参数(透传自 obj2gltf,一般无需设置):`--checkTransparency`、`--packOcclusion`、`--metallicRoughness`、`--specularGlossiness`、`--unlit`,详见 `modelTo3DTiles -h`。

## 调参建议

瓦片策略(`--split` / `--tileSize`)的收益取决于**浏览方式**,按场景选择:

| 场景 | 推荐配置 | 原因 |
|---|---|---|
| 全景展示、单体小模型(如单台设备) | `--split material` | 按材质顺序装填,draw call 恒为材质数(理论下限),文件最小 |
| 大场景漫游、室内浏览 | 默认空间切分 | 视野收窄时只绘制可见瓦片,draw call 持续下降 |
| 大模型 + 深度漫游 | `--ts 2~4` | 空间切分的收益 = 瓦片粒度 × 视野占比,百米级模型默认 10MB 粒度偏粗,调小后视锥剔除更敏感 |

粒度调细的代价:瓦片数与文件数增多、同材质在多个瓦片重复出现(全景时 draw call 总量升高)。环形/碗状模型(体育场等)通用切分只能产生粗大条块,深度漫游建议直接调小 `--tileSize`。

## 输出结构

```
output/
├── tileset.json      # 3D Tiles 入口
├── Tile-0.b3dm       # 瓦片内容(b3dm或glb)
├── Tile-1.b3dm
└── textures/         # 外置共享贴图(--textureAtlas时含图集页)
```

**注意**:`textures/` 目录与瓦片文件必须整体分发,不可只拷贝 `.b3dm` 文件。

## Cesium 加载

```js
const tileset = await Cesium.Cesium3DTileset.fromUrl('output/tileset.json');
viewer.scene.primitives.add(tileset);
viewer.zoomTo(tileset);

// 构件级拾取:点击查询构件名称、单独显隐/着色
const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
handler.setInputAction(movement => {
    const feature = viewer.scene.pick(movement.position);
    if (feature instanceof Cesium.Cesium3DTileFeature) {
        console.log(feature.getProperty('name'));  // 构件名称
        feature.color = Cesium.Color.RED;          // 单构件高亮
    }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
```

## 在 threejs 中使用

两种方式,按场景选择。

**方式一:直接加载瓦片 GLB**(简单场景,自行管理相机与剔除)

转换时用 `--no-b3dm` 输出 glTF 瓦片,遍历 `tileset.json` 逐个加载合成。输出为模型局部坐标系(米,Y-up),不含地理定位,需自行摆放:

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// 默认开启的Draco压缩需要配置解码器
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

const group = new THREE.Group();
const tileset = await (await fetch('output/tileset.json')).json();
for (const child of tileset.root.children) {
    const gltf = await loader.loadAsync('output/' + child.content.uri);
    group.add(gltf.scene);
}
scene.add(group);
```

**方式二:经 [3d-tiles-renderer](https://github.com/NASA-AMMOS/3d-tiles-renderer) 加载完整 tileset**(需要瓦片调度、视锥剔除时)

```js
import { TilesRenderer } from '3d-tiles-renderer';

const tiles = new TilesRenderer('output/tileset.json');
tiles.setCamera(camera);
tiles.setResolutionFromRenderer(renderer);
scene.add(tiles.group);

// 渲染循环中更新
tiles.update();
```

说明:

- 启用 `--draco` 时务必配置 `DRACOLoader`(b3dm 容器需自行剥离 28 字节头再交由 GLTFLoader,建议直接用 `--no-b3dm`);
- `textures/` 目录需与瓦片同目录部署(外置贴图按相对路径解析);
- 构件拾取扩展(`EXT_mesh_features`)threejs 不识别会忽略,构件名保留在 glTF 节点名中,可按 `object.name` 检索。

## 从源码构建 exe

```bash
npm install
npm run build        # esbuild打包 + pkg封装为 node22-win-x64 可执行文件
```

产物约 210MB(内嵌 Node 运行时、Cesium 资源与 Draco/图像原生库),首次构建需从网络下载 Node 运行时。

## License

[MIT](./LICENSE)
