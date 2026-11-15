// Bundles source/src into a single self-contained index.html.
//   node build.mjs              minified build
//   node build.mjs --readable   unminified, for reading and debugging
//   node build.mjs --watch      rebuild on every change

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const readable = process.argv.includes('--readable');
const watch = process.argv.includes('--watch');

// Squeeze whitespace and comments out of the WGSL template literals in
// shaders.js before esbuild sees it (esbuild leaves string contents alone).
const shrinkWgsl = {
  name: 'shrink-wgsl',
  setup(build) {
    build.onLoad({ filter: /shaders\.js$/ }, (args) => {
      let src = readFileSync(args.path, 'utf8');
      if (!readable) {
        src = src.replace(/\/\* wgsl \*\/ `([^`]*)`/g, (_, body) =>
          '`' + body.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/ ?([{}();,:=<>+*\/-]) ?/g, '$1').replace(/-(?=-)/g, '- ') + '`');
      }
      return { contents: src, loader: 'js' };
    });
  },
};

const writeHtml = {
  name: 'write-html',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
      const template = readFileSync('source/template.html', 'utf8');
      const html = template.replace('<!--APP-->', () => `<script>${js}</script>`);
      writeFileSync('index.html', html);
      console.log(`index.html  ${(html.length / 1024).toFixed(1)} KB${readable ? ' (readable)' : ''}`);
    });
  },
};

const options = {
  entryPoints: ['source/src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: !readable,
  legalComments: 'none',
  write: false,
  plugins: [shrinkWgsl, writeHtml],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching source/ ...');
} else {
  await esbuild.build(options);
}
