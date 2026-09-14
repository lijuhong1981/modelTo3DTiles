/**
 * 极简静态文件服务器，用于本地测试Cesium/three.js页面。
 * 用法: SOURCE_ROOT=<原始模型目录> node test/server.js [端口，默认8080]
 * 站点根目录为仓库根目录，因此页面可引用 node_modules/ 下的Cesium与 test-output/ 下的瓦片；
 * /source/ 前缀映射到 SOURCE_ROOT 指定的原始模型目录（用于对比测试），
 * 未设置时回退到仓库根下的 test-source/ 目录（可在该目录放置测试模型）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sourceRoot = process.env.SOURCE_ROOT || path.join(root, 'test-source');
const port = Number(process.argv[2]) || 8080;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.glb': 'model/gltf-binary',
    '.bin': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ktx2': 'image/ktx2',
    '.wasm': 'application/wasm',
    '.gltf': 'model/gltf+json',
    '.fbx': 'application/octet-stream',
    '.obj': 'text/plain',
    '.mtl': 'text/plain',
};

const server = http.createServer((request, response) => {
    const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    let baseRoot = root, relativePath = urlPath;
    if (urlPath.startsWith('/source/')) {
        baseRoot = sourceRoot;
        relativePath = urlPath.slice('/source/'.length);
    }
    // 防目录穿越（剥掉前导斜杠，避免Windows下被当作盘符绝对路径）
    const relPath = relativePath.replace(/^[\/\\]+/, '');
    if (!path.resolve(baseRoot, relPath).startsWith(path.resolve(baseRoot) + path.sep)) {
        response.writeHead(403);
        return response.end('Forbidden');
    }
    let filePath = path.join(baseRoot, relPath);
    if (urlPath === '/' || urlPath === '/test/') {
        filePath = path.join(root, 'test', 'index.html');
    }
    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            response.writeHead(404);
            return response.end('Not Found: ' + urlPath);
        }
        response.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
        });
        fs.createReadStream(filePath).pipe(response);
    });
});

server.listen(port, () => {
    console.log(`测试服务器已启动: http://localhost:${port}/test/index.html (Cesium瓦片对比)`);
    console.log(`                          http://localhost:${port}/test/three.html (原始模型对比)`);
    console.log(`站点根目录: ${root}`);
    console.log(`原始模型目录(/source/): ${sourceRoot}${process.env.SOURCE_ROOT ? '' : ' (未设置SOURCE_ROOT环境变量，使用回退目录)'}`);
});
