const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('api', {
  clipboard: {
    readText: invoke('clipboard:readText'),
    writeText: invoke('clipboard:writeText'),
    saveImage: invoke('clipboard:saveImage')
  },
  shell: { openExternal: invoke('shell:openExternal') },
  settings: { get: invoke('settings:get'), save: invoke('settings:save') },
  hosts: { list: invoke('hosts:list'), save: invoke('hosts:save') },
  ssh: {
    connect: invoke('ssh:connect'),
    disconnect: invoke('ssh:disconnect'),
    onStatus: on('ssh:status')
  },
  setup: {
    detect: invoke('setup:detect'),
    installAgent: invoke('setup:installAgent'),
    setApiKey: invoke('setup:setApiKey'),
    syncAuth: invoke('setup:syncAuth'),
    detectLocalCodex: invoke('setup:detectLocalCodex'),
    testRemoteAgent: invoke('setup:testRemoteAgent'),
    configureProxy: invoke('proxy:configure'),
    lanIp: invoke('net:lanIp'),
    exportDiagnostics: invoke('diag:export'),
    onLog: on('setup:log')
  },
  convos: { list: invoke('convos:list'), save: invoke('convos:save') },
  tasks: { list: invoke('tasks:list'), save: invoke('tasks:save') },
  agent: {
    start: invoke('agent:start'),
    send: invoke('agent:send'),
    cancel: invoke('agent:cancel'),
    onMessage: on('agent:message')
  },
  files: {
    listLocal: invoke('fs:listLocal'),
    listRemote: invoke('fs:listRemote'),
    upload: invoke('fs:upload'),
    uploadDirectory: invoke('fs:uploadDirectory'),
    download: invoke('fs:download'),
    downloadDirectory: invoke('fs:downloadDirectory'),
    readFile: invoke('fs:readFile'),
    saveText: invoke('fs:saveText'),
    imageThumb: invoke('fs:imageThumb'),
    mkdirRemote: invoke('fs:mkdirRemote'),
    deleteRemote: invoke('fs:deleteRemote'),
    onProgress: on('transfer:progress')
  },
  dialog: {
    pickFile: invoke('dialog:pickFile'),
    pickFiles: invoke('dialog:pickFiles'),
    pickKeyFile: invoke('dialog:pickKeyFile'),
    pathForDroppedFile: (file) => webUtils.getPathForFile(file)
  },
  attachments: {
    prepare: invoke('attachments:prepare'),
    resolveImage: invoke('attachments:resolveImage'),
    cleanup: invoke('attachments:cleanup')
  },
  term: {
    open: invoke('term:open'),
    reconnect: invoke('term:reconnect'),
    close: invoke('term:close'),
    write: invoke('term:write'),
    resize: invoke('term:resize'),
    onData: on('term:data'),
    onClosed: on('term:closed')
  }
});
