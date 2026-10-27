import { create } from 'zustand';
import type { AgentHarness } from '../shared/types';

export type ProviderFilter = 'all' | AgentHarness;
export type SettingsSection = 'general' | 'servers' | 'local' | 'pricing' | 'about';

interface DashboardUiState {
  providerFilter: ProviderFilter;
  selectedRunId?: string;
  selectedAgentId: string | null;
  /** The settings page replaces the dashboard while a section is open. */
  settingsSection: SettingsSection | null;
  setProviderFilter: (providerFilter: ProviderFilter) => void;
  selectRun: (selectedRunId?: string) => void;
  selectAgent: (selectedAgentId: string | null) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
}

export const useDashboardStore = create<DashboardUiState>((set) => ({
  providerFilter: 'all',
  selectedRunId: undefined,
  selectedAgentId: null,
  settingsSection: null,
  setProviderFilter: (providerFilter) => set({ providerFilter, selectedRunId: undefined, selectedAgentId: null }),
  selectRun: (selectedRunId) => set({ selectedRunId, selectedAgentId: null }),
  selectAgent: (selectedAgentId) => set({ selectedAgentId }),
  openSettings: (section) => set((state) => ({ settingsSection: section ?? state.settingsSection ?? 'general' })),
  closeSettings: () => set({ settingsSection: null }),
}));
