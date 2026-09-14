# modelTo3DTiles

一个将普通精细模型转换为3DTiles模型的工具，支持.obj、.fbx、.gltf、.glb等格式的转换。

## 使用

1、下载[modelTo3DTiles.exe](./modelTo3DTiles.exe)文件到本地

2、打开命令行工具,使用cd命令至modelTo3DTiles.exe文件所在目录

3、输入命令行 "modelTo3DTiles -h" 查看命令

4、输入命令行 "modelTo3DTiles -i inputPath" 替换inputPath为要转换的模型文件路径

示例：modelTo3DTiles -i ./两江影视城站_AFC设备模型+公共区装修/两江影视城站_AFC设备模型+公共区装修.obj

## 命令参数

|参数名称|别名|描述|类型|默认值|是否必须|
|:---:|:---:|:---:|:---:|:---:|:---:|
|--help|-h|显示帮助|Boolean||否|
|--version|-v|显示版本号|Boolean||否|
|--input|-i|输入模型路径|String||是|
|--output|-o|模型输出目录,<br>不填则在模型文件目录下自动创建一个3dtiles目录。|String||否|
|--inputUpAxis|--iua|设置输入模型的向上坐标轴,<br>obj默认按Z-up处理并自动转换,<br>fbx默认读取文件GlobalSettings声明的UpAxis,<br>gltf/glb按规范固定为Y-up。|String|见描述|否|
|--rotation|-r|手动设置模型旋转角度,<br>格式为[x,y,z],单位为度。<br>坐标轴朝向已自动归一化,<br>仅当模型存在轴向以外的偏转<br>(如偏离正北)时才需要设置。|String||否|
|--lngLatAlt|--lla|设置模型经度、纬度、海拔高度,<br>格式为[longitude,latitude,altitude],<br>高度单位为米。|String||否|
|--correctCenter|--cc|自动修正模型锚点至模型<br>包围盒中心点,<br>修正后经纬度对应包围盒中心。|Boolean|true|否|
|--b3dm||以b3dm容器输出瓦片,<br>3D Tiles经典格式,兼容传统前端;<br>关闭则输出glTF瓦片(3D Tiles 1.1)。|Boolean|true|否|
|--spatialSplit|-ss|按空间递归切分瓦片,<br>空间聚集便于视锥剔除;<br>关闭则按材质顺序装填,<br>适合单体小模型<br>(不做几何切分、保留索引几何)。|Boolean|true|否|
|--textureAtlas|--ta|启用纹理图集优化:<br>将可合并材质的贴图按尺寸分桶<br>合成2的幂网格图集页并重映射UV,<br>减少材质数与draw call;<br>非2的幂贴图重采样至最近2的幂。<br>仅baseColor贴图、UV在[0,1]内的<br>材质参与合并。|Boolean|false|否|
|--resampleTextures|-rst|将非2的幂贴图重采样至<br>最近2的幂(含全部贴图槽位),<br>避免Cesium将NPOT纹理放大到<br>下一2的幂导致显存膨胀;<br>启用textureAtlas时无需单独开启。|Boolean|false|否|
|--mergePrimitive|-mp|设置是否合并材质相同的网格图元。|Boolean|true|否|
|--tileSize|-ts|设置期望的单个瓦片存储容量,<br>单位mb。|Number|10|否|
|--clampToGround|--ctg|设置模型是否自动贴地,<br>为true时altitude属性失效。|Boolean|true|否|
|--noneTransform|--nt|是否不设置模型变换矩阵,<br>为true时lngLatAlt、clampToGround等<br>属性失效。|Boolean|false|否|
