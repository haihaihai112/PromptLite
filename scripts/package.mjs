import { packager } from '@electron/packager';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { copyFile } from 'node:fs/promises';
const require=createRequire(import.meta.url);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outputs=await packager({dir:root,name:'PromptLite',appBundleId:'io.github.haihaihai112.promptlite',
  platform:'win32',arch:'x64',out:path.join(root,'release'),overwrite:true,asar:true,prune:true,icon:path.join(root,'assets/icon.ico'),
  download:{checksums:require('electron/checksums.json')},
  appCopyright:'Copyright © 2026 haihaihai112',
  win32metadata:{CompanyName:'haihaihai112',FileDescription:'PromptLite 个人提示词工作台',ProductName:'PromptLite',InternalName:'PromptLite'},
  ignore:[/^\/src(?:\/|$)/,/^\/electron(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/docs(?:\/|$)/,/^\/scripts(?:\/|$)/,/^\/node_modules(?:\/|$)/,/^\/release(?:\/|$)/,/^\/.git(?:\/|$)/,/^\/.*\.log$/,/^\/tsconfig.*\.json$/,/^\/vite\.config\.ts$/,/^\/package-lock\.json$/,/^\/index\.html$/],
});
for(const output of outputs){
  await copyFile(path.join(root,'README.md'),path.join(output,'README.md'));
  await copyFile(path.join(root,'LICENSE'),path.join(output,'SOURCE_LICENSE.txt'));
  await copyFile(path.join(root,'THIRD_PARTY_NOTICES.md'),path.join(output,'THIRD_PARTY_NOTICES.md'));
  console.log(output);
}
