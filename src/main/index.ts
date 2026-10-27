import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { MultiSourceMonitor } from './trace-monitor/MultiSourceMonitor';
import { ConfigErrorSource, loadServersConfig, serversConfigPath } from './remote/config';
import { loadAgentBundle } from './remote/agentBundle';
import { ServerManager } from './remote/serverManager';
import { ServersStore } from './remote/serversStore';
import { loadSshHosts } from './remote/sshConfig';
import { SettingsManager, SettingsStore, settingsPath } from './settings';

let window: BrowserWindow | null = null;
const remotes = loadServersConfig(app.getPath('userData'));
const monitor = new MultiSourceMonitor([]);
// Local watchers (Hermes database and trace files) follow settings.json and restart when it changes.
const settings = new SettingsManager({ monitor, store: new SettingsStore(settingsPath(app.getPath('userData'))) }, remotes.errors);
// Remote servers, including ones added and removed from the app; managed servers must run exactly the bundled agent.
const servers = new ServerManager({
  monitor,
  store: new ServersStore(serversConfigPath(app.getPath('userData'))),
  bundle: () => loadAgentBundle({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, mainDir: __dirname }),
  sshHosts: () => loadSshHosts(),
  onProgress: progress => { if (window && !window.webContents.isDestroyed()) window.webContents.send('servers:progress', progress); },
});
const serversLoaded = settings.load().then(() => servers.load(remotes.servers, remotes.errors)).then(async () => {
  if (remotes.errors.length) await monitor.addSource(new ConfigErrorSource(remotes.errors));
});
const developmentUrl = process.env.VITE_DEV_SERVER_URL;
// Packaged apps ship the icon as an extra resource; development reads it from build/ (icon.icns and icon.ico sit beside it).
const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../build/icon.png');
function assertSender(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted IPC sender');
}
function createWindow() {
  window = new BrowserWindow({ show: false, width: 1500, height: 950, minWidth: 960, minHeight: 640, backgroundColor: '#0c1016', title: 'Agent Monitor', icon: iconPath,
    // macOS: draw the window controls over the app's own header instead of a separate light title bar.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 20, y: 21 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.once('ready-to-show', () => { window?.show(); window?.maximize(); });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('closed', () => { window = null; });
  if (developmentUrl) {
    const parsed = new URL(developmentUrl);
    // scripts/dev.mjs may bind any free port; only a loopback Vite server in an unpackaged app is trusted.
    if (app.isPackaged || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) throw new Error('Unexpected development server URL');
    void window.loadURL(developmentUrl);
  } else void window.loadFile(path.join(__dirname, '../dist/index.html'));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  void app.whenReady().then(() => {
    ipcMain.handle('monitor:snapshot', event => { assertSender(event); return monitor.snapshot(); });
    ipcMain.handle('monitor:trace', (event, agentId: unknown) => {
      assertSender(event);
      if (typeof agentId !== 'string' || agentId.length > 1024) throw new Error('Invalid agent identifier');
      return monitor.getTrace(agentId);
    });
    ipcMain.handle('monitor:load-run', (event, runId: unknown) => {
      assertSender(event);
      if (typeof runId !== 'string' || !runId || runId.length > 1024) throw new Error('Invalid run identifier');
      return monitor.loadRun(runId);
    });
    ipcMain.handle('servers:list-ssh-hosts', event => { assertSender(event); return servers.listSshHosts(); });
    ipcMain.handle('servers:list', event => { assertSender(event); return servers.listServers(); });
    ipcMain.handle('servers:probe', (event, request: unknown) => { assertSender(event); return servers.probeServer(request); });
    ipcMain.handle('servers:add', (event, request: unknown) => { assertSender(event); return servers.addServer(request); });
    ipcMain.handle('servers:update', (event, request: unknown) => { assertSender(event); return servers.updateServer(request); });
    ipcMain.handle('settings:get', event => { assertSender(event); return settings.get(); });
    ipcMain.handle('settings:update', (event, request: unknown) => { assertSender(event); return settings.update(request); });
    ipcMain.handle('servers:remove', (event, request: unknown) => { assertSender(event); return servers.removeServer(request); });
    monitor.on('snapshot', snapshot => { if (window && !window.webContents.isDestroyed()) window.webContents.send('monitor:changed', snapshot); });
    // Unpackaged macOS runs show Electron's own Dock icon unless it is replaced; packaged apps use the bundle icon.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconPath);
    createWindow();
    void serversLoaded.then(() => monitor.start()).catch(error => { console.error('Trace monitor failed:', error); });
    app.on('activate', () => { if (!window) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  let stopping = false;
  app.on('before-quit', event => {
    if (stopping) return;
    event.preventDefault(); stopping = true;
    void monitor.stop().finally(() => app.quit());
  });
}
