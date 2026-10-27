import { create } from 'zustand';
import type { AgentHarness } from '../shared/types';
import { HOST_ALL, type HostFilter } from './remoteUi';

export type ProviderFilter = 'all' | AgentHarness;
export type { HostFilter } from './remoteUi';

interface DashboardUiState {
  providerFilter: ProviderFilter;
  hostFilter: HostFilter;
  selectedRunId?: string;
  selectedAgentId: string | null;
  setProviderFilter: (providerFilter: ProviderFilter) => void;
  setHostFilter: (hostFilter: HostFilter) => void;
  /** Drops a host filter whose host is no longer configured, keeping the current selection. */
  resetHostFilter: () => void;
  selectRun: (selectedRunId?: string) => void;
  selectAgent: (selectedAgentId: string | null) => void;
}

export const useDashboardStore = create<DashboardUiState>((set) => ({
  providerFilter: 'all',
  hostFilter: HOST_ALL,
  selectedRunId: undefined,
  selectedAgentId: null,
  setProviderFilter: (providerFilter) => set({ providerFilter, selectedRunId: undefined, selectedAgentId: null }),
  setHostFilter: (hostFilter) => set({ hostFilter, selectedRunId: undefined, selectedAgentId: null }),
  resetHostFilter: () => set({ hostFilter: HOST_ALL }),
  selectRun: (selectedRunId) => set({ selectedRunId, selectedAgentId: null }),
  selectAgent: (selectedAgentId) => set({ selectedAgentId }),
}));
