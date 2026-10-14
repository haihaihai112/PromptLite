import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1'],{stdio:'inherit'});
let desktop;
async function stop(){desktop?.kill();vite.kill();}
process.on('SIGINT',()=>{void stop();process.exit(0);});
process.on('SIGTERM',()=>{void stop();process.exit(0);});
try{
  const start=Date.now();
  for(;;){try{await fetch('http://127.0.0.1:5173/');break;}catch{if(Date.now()-start>15000)throw new Error('开发服务启动超时');await new Promise(resolve=>setTimeout(resolve,200));}}
  desktop=spawn(require('electron'),['.'],{stdio:'inherit',env:{...process.env,VITE_DEV_SERVER_URL:'http://127.0.0.1:5173/'}});
  desktop.once('exit',()=>{vite.kill();});
}catch(error){console.error(error.message);await stop();process.exitCode=1;}
