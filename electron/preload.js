// 注意:渲染进程默认沙箱化,preload 只能 require('electron') 等白名单模块,
// 不能 require 相对路径文件(会抛错导致 window.api 未暴露 → 白/黑屏)。
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
    writeImage: invoke('clipboard:writeImage'),
    saveImage: invoke('clipboard:saveImage'),
    saveImageAs: invoke('image:saveAs')
  },
  shell: { openExternal: invoke('shell:openExternal') },
  settings: { get: invoke('settings:get'), save: invoke('settings:save') },
  stt: {
    getConfig: invoke('stt:getConfig'),
    setConfig: invoke('stt:setConfig'),
    transcribe: invoke('stt:transcribe'),
    test: invoke('stt:test')
  },
  voice: { interpret: invoke('voice:interpret') },
  screenshot: {
    capture: invoke('screenshot:capture'),
    shortcutStatus: invoke('screenshot:shortcutStatus'),
    onCaptured: on('screenshot:captured')
  },
  hosts: { list: invoke('hosts:list'), save: invoke('hosts:save') },
  ssh: {
    connect: invoke('ssh:connect'),
    disconnect: invoke('ssh:disconnect'),
    onStatus: on('ssh:status')
  },
  deepseek: {
    parseRelay: invoke('deepseek:parseRelay'),
    testEndpoint: invoke('deepseek:testEndpoint'),
    listModels: invoke('deepseek:listModels')
  },
  web: {
    list: invoke('web:list'),
    start: invoke('web:start'),
    stop: invoke('web:stop'),
    waitReady: invoke('web:waitReady'),
    onLog: on('web:log'),
    onWaiting: on('web:waiting')
  },
  setup: {
    detect: invoke('setup:detect'),
    installAgent: invoke('setup:installAgent'),
    setApiKey: invoke('setup:setApiKey'),
    setEnvKey: invoke('setup:setEnvKey'),
    syncAuth: invoke('setup:syncAuth'),
    detectLocalCodex: invoke('setup:detectLocalCodex'),
    detectLocalClaude: invoke('setup:detectLocalClaude'),
    testRemoteAgent: invoke('setup:testRemoteAgent'),
    configureProxy: invoke('proxy:configure'),
    lanIp: invoke('net:lanIp'),
    exportDiagnostics: invoke('diag:export'),
    onLog: on('setup:log')
  },
  convos: { list: invoke('convos:list'), save: invoke('convos:save') },
  autocapture: {
    check: invoke('autocapture:check'),
    diagnoseRemote: invoke('autocapture:diagnoseRemote'),
    getConfig: invoke('autocapture:getConfig'),
    setConfig: invoke('autocapture:setConfig'),
    runNow: invoke('autocapture:runNow'),
    backfillEstimate: invoke('autocapture:backfillEstimate'),
    backfill: invoke('autocapture:backfill'),
    onProgress: on('autocapture:progress'),
    onDone: on('autocapture:done')
  },
  mobile: {
    getConfig: invoke('mobile:getConfig'),
    setConfig: invoke('mobile:setConfig'),
    rotateToken: invoke('mobile:rotateToken'),
    installBridge: invoke('mobile:installBridge'),
    previewBridge: invoke('mobile:previewBridge'),
    listTasks: invoke('mobile:listTasks'),
    onConversation: on('mobile:conversation')
  },
  skills: {
    listBuiltin: invoke('skills:listBuiltin'),
    engineDirs: invoke('skills:engineDirs'),
    lint: invoke('skills:lint'),
    listInstalled: invoke('skills:listInstalled'),
    install: invoke('skills:install'),
    remove: invoke('skills:remove'),
    marketSources: invoke('skills:marketSources'),
    marketList: invoke('skills:marketList'),
    marketFetch: invoke('skills:marketFetch'),
    onLog: on('skills:log')
  },
  obsidian: {
    getConfig: invoke('obsidian:getConfig'),
    setConfig: invoke('obsidian:setConfig'),
    test: invoke('obsidian:test'),
    pickVault: invoke('obsidian:pickVault'),
    createVault: invoke('obsidian:createVault'),
    quickStart: invoke('obsidian:quickStart'),
    diagnose: invoke('obsidian:diagnose'),
    saveBrief: invoke('obsidian:saveBrief'),
    saveFromConversation: invoke('obsidian:saveFromConversation'),
    graph: invoke('obsidian:graph'),
    readNoteFile: invoke('obsidian:readNoteFile'),
    deleteNote: invoke('obsidian:deleteNote'),
    openInApp: invoke('obsidian:openInApp'),
    onProgress: on('obsidian:progress')
  },
  prism: {
    getConfig: invoke('prism:getConfig'),
    setConfig: invoke('prism:setConfig'),
    register: invoke('prism:register'),
    health: invoke('prism:health'),
    capabilities: invoke('prism:capabilities'),
    execute: invoke('prism:execute'),
    saveAsBrief: invoke('prism:saveAsBrief'),
    deployPrompt: invoke('prism:deployPrompt')
  },
  brief: {
    get: invoke('brief:get'),
    run: invoke('brief:run'),
    dates: invoke('brief:dates'),
    today: invoke('brief:today'),
    onProgress: on('brief:progress')
  },
  agent: {
    start: invoke('agent:start'),
    send: invoke('agent:send'),
    cancel: invoke('agent:cancel'),
    onMessage: on('agent:message')
  },
  files: {
    cancelTransfer: invoke('fs:cancelTransfer'),
    listLocal: invoke('fs:listLocal'),
    listRemote: invoke('fs:listRemote'),
    upload: invoke('fs:upload'),
    download: invoke('fs:download'),
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
