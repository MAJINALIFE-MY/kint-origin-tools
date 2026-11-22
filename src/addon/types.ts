export interface AddonManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  description: string;
  commands: Record<string, string>;
}

export interface AddonCandidate {
  name: string;
  root: string;
  manifest: AddonManifest;
  skills: string[];
  rules: string[];
}

export interface AddonLink {
  path: string;
  target: string;
}

export interface InstalledAddon {
  version?: string;
  links: AddonLink[];
  rules?: string[];
}

export interface AddonState {
  schemaVersion: 1;
  addons: Record<string, InstalledAddon>;
  generated: Record<string, string>;
}

export interface AddonListEntry {
  name: string;
  version: string | null;
  description: string | null;
  status: "available" | "installed" | "needs-update" | "source-missing" | "invalid";
  issues: string[];
}

export interface AddonListResult {
  sourceConfigured: boolean;
  addons: AddonListEntry[];
}

export interface AddonChangeResult {
  operation: "install" | "update" | "remove";
  addon: string;
  created: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
  warnings: string[];
  aborted: boolean;
}

export interface AddonContext {
  domainRoot: string;
  addonDirectory: string;
  stateDirectory: string;
  cliPath: string;
}

export type AddonOperationPlan = {
  operation: "install" | "update" | "remove";
  addon: string;
  nextState: AddonState;
  desiredLinks: AddonLink[];
  removedLinks: AddonLink[];
  fileWrites: Array<{ path: string; content: string }>;
};
