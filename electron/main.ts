import { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage, Menu, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFile, writeFile, stat, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AppStore } from './store.js';
import { streamChat } from '../src/core/client.js';
import { isTrustedDocument, validateRunRequest, validateId } from './security.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
app.setName('PromptLite');
if(process.env.PROMPTLITE_USER_DATA){
  const directory=process.env.PROMPTLITE_USER_DATA;
  if(!path.isAbsolute(directory))throw new Error('PROMPTLITE_USER_DATA 必须是绝对路径。');
  app.setPath('userData',directory);
}
const ownsLock=app.requestSingleInstanceLock();
let window: BrowserWindow | null=null;
let documentUrl='';
let store: AppStore;
const pending=new Map<string,AbortController>();

function trusted(event:IpcMainInvokeEvent){
  if(!window||event.sender.id!==window.webContents.id||event.senderFrame!==event.sender.mainFrame||
    !isTrustedDocument(event.senderFrame?.url??'',documentUrl))throw new Error('拒绝来自非应用窗口的请求。');
}
function handle(channel:string, action:(argument:any,event:IpcMainInvokeEvent)=>unknown){
  ipcMain.handle(`promptlite:${channel}`,async(event,argument)=>{trusted(event);return action(argument,event);});
}
function abortAll(){for(const controller of pending.values())controller.abort();pending.clear();}
function registerIPC(){
  handle('load',()=>store.load());
  handle('model-save',value=>store.saveModel(value));
  handle('model-delete',value=>store.deleteModel(value));
  handle('history-save',value=>store.saveHistory(value));
  handle('history-delete',value=>store.deleteHistory(value));
  handle('favorite-save',value=>store.saveFavorite(value));
  handle('favorite-delete',value=>store.deleteFavorite(value));
  handle('copy',value=>{if(typeof value!=='string'||value.length>400_000)throw new Error('复制内容无效或过长。');clipboard.writeText(value);});
  handle('cancel',value=>{validateId(value);pending.get(value)?.abort();});
  handle('run',async(value,event)=>{
    validateRunRequest(value);
    if(pending.has(value.requestId))throw new Error('请求标识已在使用。');
    if(pending.size>=3)throw new Error('正在执行其他请求，请等待或取消后重试。');
    const controller=new AbortController();pending.set(value.requestId,controller);
    try {
      const model=await store.getModelConnection(value.modelId);
      return await streamChat(model,structuredClone(value.messages),controller.signal,delta=>{
        if(!event.sender.isDestroyed())event.sender.send('promptlite:delta',{requestId:value.requestId,delta});
      });
    }finally{pending.delete(value.requestId);}
  });
  handle('backup-export',async()=>{
    const choice=await dialog.showSaveDialog(window!,{title:'导出本地备份',defaultPath:`PromptLite-${new Date().toISOString().slice(0,10)}.json`,filters:[{name:'JSON 备份',extensions:['json']}],properties:['showOverwriteConfirmation']});
    if(choice.canceled||!choice.filePath)return null;
    const temp=`${choice.filePath}.${randomUUID()}.tmp`;
    try{await writeFile(temp,await store.exportBackup(),'utf8');await rename(temp,choice.filePath);}
    finally{await unlink(temp).catch(()=>{});}
    return choice.filePath;
  });
  handle('backup-import',async()=>{
    const choice=await dialog.showOpenDialog(window!,{title:'选择 PromptLite JSON 备份',properties:['openFile'],filters:[{name:'JSON 备份',extensions:['json']}]});
    if(choice.canceled||!choice.filePaths[0])return null;
    const selected=choice.filePaths[0];
    if((await stat(selected)).size>20*1024*1024)throw new Error('备份超过 20 MiB，请使用较小的备份文件。');
    return store.importBackup(await readFile(selected,'utf8'));
  });
}
async function createWindow(){
  const developmentUrl=process.env.VITE_DEV_SERVER_URL;
  if(developmentUrl&&developmentUrl!=='http://127.0.0.1:5173/')throw new Error('开发服务地址仅允许 http://127.0.0.1:5173/。');
  documentUrl=developmentUrl??pathToFileURL(path.join(root,'dist/index.html')).href;
  window=new BrowserWindow({width:1380,height:920,minWidth:760,minHeight:660,title:'PromptLite',icon:path.join(root,'assets/icon.png'),backgroundColor:'#f3f6fb',show:false,
    webPreferences:{preload:path.join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(!isTrustedDocument(url,documentUrl))event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMainFrame)=>{if(isMainFrame)abortAll();});
  window.on('closed',()=>{abortAll();window=null;});
  window.once('ready-to-show',()=>window?.show());
  await window.loadURL(documentUrl);
}
if(!ownsLock){app.quit();}else{
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
  app.whenReady().then(async()=>{
    session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    store=new AppStore(path.join(app.getPath('userData'),'promptlite.json'),{
      isAvailable:()=>safeStorage.isEncryptionAvailable(),
      encrypt:value=>safeStorage.encryptString(value).toString('base64'),
      decrypt:value=>safeStorage.decryptString(Buffer.from(value,'base64')),
    });
    registerIPC();await createWindow();
  }).catch(error=>{dialog.showErrorBox('PromptLite 无法启动',error instanceof Error?error.message:'启动失败。');app.quit();});
  app.on('activate',()=>{if(!window)void createWindow();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',abortAll);
}
