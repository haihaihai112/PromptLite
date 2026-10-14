import { packager } from '@electron/packager';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outputs=await packager({dir:root,name:'PromptLite',appBundleId:'io.github.haihaihai112.promptlite',
  platform:'win32',arch:'x64',out:path.join(root,'release'),overwrite:true,asar:true,prune:true,icon:path.join(root,'assets/icon.ico'),
  appCopyright:'Copyright © 2026 haihaihai112',
  win32metadata:{CompanyName:'haihaihai112',FileDescription:'PromptLite 个人提示词工作台',ProductName:'PromptLite',InternalName:'PromptLite'},
  ignore:[/^\/src(?:\/|$)/,/^\/electron(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/docs(?:\/|$)/,/^\/scripts(?:\/|$)/,/^\/node_modules(?:\/|$)/,/^\/release(?:\/|$)/,/^\/.git(?:\/|$)/,/^\/.*\.log$/,/^\/tsconfig.*\.json$/,/^\/vite\.config\.ts$/,/^\/package-lock\.json$/,/^\/index\.html$/],
});
for(const output of outputs)console.log(output);
