const fsExtra = require("fs-extra");
const path = require("path");
const defined = require("./defined");
import { FBXLoader } from "./loaders/FBXLoader.js";

module.exports = loadFBX;

/**
 * 加载FBX文件并统一转换为threejs的Y-up朝向
 * （GLB内容按glTF的Y-up规范导出，Cesium渲染时会自动转换为Z-up）
 * @param {string} inputPath
 * @param {object} options
 * @returns {Promise<Group>}
 */
async function loadFBX(inputPath, options) {
    console.time('loadFBXTime');
    const buffer = await fsExtra.readFile(inputPath);
    const dirPath = path.dirname(inputPath);
    const scene = new FBXLoader().parse(buffer.buffer, dirPath);
    // 优先使用用户指定的向上轴，否则使用FBX文件GlobalSettings声明的UpAxis
    const upAxis = defined(options.inputUpAxis) ? options.inputUpAxis : (scene.userData.upAxis || "Y");
    console.log('FBX UpAxis:', upAxis);
    switch (upAxis) {
        case "Z":
            scene.rotateX(-Math.PI / 2); // 顶部+z → +y
            break;
        case "-Z":
            scene.rotateX(Math.PI / 2);
            break;
        case "X":
            scene.rotateZ(Math.PI / 2); // 顶部+x → +y
            break;
        case "-X":
            scene.rotateZ(-Math.PI / 2);
            break;
    }
    console.timeEnd('loadFBXTime');
    return scene;
};
