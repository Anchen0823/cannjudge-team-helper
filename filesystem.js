/* File System Access transport: user selects only the dedicated exchange folder. */
async function startFilesystemBackground() {
  if(location.origin!=='https://cannjudge.cn')throw Error('请在已登录的 CANNJudge 页面启动');
  if(window.__cannBackground)throw Error('请先点右下角停止旧助手，或刷新题目页，再启动文件夹版');
  if(typeof window.showDirectoryPicker!=='function')throw Error('当前浏览器不支持目录访问，请使用 Chrome');
  const directory=await window.showDirectoryPicker({id:'cannjudge-background-exchange',mode:'readwrite'});
  const marker=JSON.parse(await(await(await directory.getFileHandle('queue-marker.json')).getFile()).text());
  if(marker.type!=='cannjudge-background-queue'||marker.version!==1)throw Error('请选择 runtime/exchange 队列文件夹');
  const requests=await directory.getDirectoryHandle('requests'),responses=await directory.getDirectoryHandle('responses');
  const transport=async(path,data)=>{
    const id=crypto.randomUUID(),name=id+'.json';
    const handle=await requests.getFileHandle(name,{create:true}),writer=await handle.createWritable();
    try{await writer.write(JSON.stringify({id,path,method:data?'POST':'GET',body:data||null}));await writer.close();}
    catch(e){try{await writer.abort();}catch{}throw e;}
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      let reply;
      try{reply=JSON.parse(await(await(await responses.getFileHandle(name)).getFile()).text());}
      catch(e){if(e.name!=='NotFoundError'&&!(e instanceof SyntaxError))throw e;}
      if(reply){
        if(reply.id!==id)throw Error('本地回执 ID 不匹配');
        // Keep request/response files for audit. The daemon never processes an ID twice.
        if(!reply.ok)throw Error(reply.error||'本地队列请求失败');
        return reply.data;
      }
      await new Promise(r=>setTimeout(r,250));
    }
    throw Error('本地队列 30 秒未响应；不会重发提交，请检查队列服务');
  };
  await startBackground({transport});
}
