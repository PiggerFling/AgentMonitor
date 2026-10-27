import { contextBridge, ipcRenderer } from 'electron';
import type { MonitorBridge, MonitorSnapshot, ServerSetupProgress } from '../shared/types';
const subscribe = <T>(channel: string, callback: (value: T) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
};
const bridge: MonitorBridge = {
  platform: process.platform,
  getSnapshot: () => ipcRenderer.invoke('monitor:snapshot'),
  getTrace: agentId => ipcRenderer.invoke('monitor:trace', agentId),
  loadRun: runId => ipcRenderer.invoke('monitor:load-run', runId),
  onSnapshot: callback => subscribe<MonitorSnapshot>('monitor:changed', callback),
  listSshHosts: () => ipcRenderer.invoke('servers:list-ssh-hosts'),
  listServers: () => ipcRenderer.invoke('servers:list'),
  probeServer: request => ipcRenderer.invoke('servers:probe', request),
  addServer: request => ipcRenderer.invoke('servers:add', request),
  updateServer: request => ipcRenderer.invoke('servers:update', request),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: settings => ipcRenderer.invoke('settings:update', settings),
  removeServer: request => ipcRenderer.invoke('servers:remove', request),
  onServerSetupProgress: callback => subscribe<ServerSetupProgress>('servers:progress', callback),
};
contextBridge.exposeInMainWorld('agentMonitor', bridge);
