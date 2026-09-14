const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// 复制 Draco WASM 文件的插件
const copyDracoWasmPlugin = {
  name: 'copy-draco-wasm',
  setup(build) {
    build.onEnd(() => {
      // 需要复制的 Draco WASM 文件列表（来自不同包：draco3dgltf为gltf输入解码,draco3d为gltf-pipeline压缩用）
      const wasmFiles = [
        { package: 'draco3dgltf', fileName: 'draco_decoder_gltf.wasm' },
        { package: 'draco3d', fileName: 'draco_decoder.wasm' },
        { package: 'draco3dgltf', fileName: 'draco_encoder.wasm' },
      ];

      wasmFiles.forEach(({ package: packageName, fileName }) => {
        const sourcePath = path.join(__dirname, 'node_modules', packageName, fileName);
        const destPath = path.join(__dirname, 'dist', fileName);

        try {
          if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);
            console.log(`✓ 已复制 ${fileName} 到 dist 目录`);
          } else {
            console.warn(`⚠ 找不到 ${fileName} 文件:`, sourcePath);
          }
        } catch (error) {
          console.error(`✗ 复制 ${fileName} 失败:`, error);
        }
      });
    });
  }
};

// 基础配置
const baseConfig = {
  entryPoints: ['./lib/modelTo3DTiles.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['cesium'], // cesium 作为外部依赖
  outfile: './dist/modelTo3DTiles.js',
  // 启用 sourcemap
  sourcemap: true,
  // 目标环境
  target: 'node18',
  // 自定义 loader
  loader: {
    '.js': 'js',
    '.json': 'json'
  },
  // 添加插件
  plugins: [copyDracoWasmPlugin]
};

// 开发模式配置
const devConfig = {
  ...baseConfig,
  minify: false,
  // 开发时输出更多信息
  logLevel: 'info'
};

// 生产模式配置
const prodConfig = {
  ...baseConfig,
  minify: true,
  // 去除 console.log 等调试代码
  drop: ['console', 'debugger'],
  // 压缩标识符
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,
  outfile: './dist/modelTo3DTiles.min.js'
};

// 分析模式配置
const analyzeConfig = {
  ...baseConfig,
  metafile: './dist/esbuild-meta.json',
  // 输出分析报告
  analyze: true
};

// module.exports = { baseConfig, devConfig, prodConfig, analyzeConfig };

// 如果直接运行此文件，则执行构建
if (require.main === module) {
  const mode = process.argv[2] || 'dev';

  console.log(`使用 esbuild 构建模式: ${mode}`);

  const config = mode === 'prod' ? prodConfig : mode === 'analyze' ? analyzeConfig : devConfig;

  // 使用普通 build 方法
  esbuild.build(config)
    .then(result => {
      console.log('构建完成!');
      if (result.metafile) {
        console.log('分析文件已生成:', result.metafile);
      }
    })
    .catch(() => process.exit(1));
}