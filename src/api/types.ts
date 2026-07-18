export interface Pagination<T> {
  total: number;
  per_page: number;
  page: number;
  data: T[];
}

export interface DirectoryEntry {
  name: string;
  mode: string;
  mode_bits: string;
  size: number;
  size_physical: number;
  editable: boolean;
  inner_editable: boolean;
  directory: boolean;
  file: boolean;
  symlink: boolean;
  mime: string;
  modified: string;
  created: string;
}

export interface DirectoryListResponse {
  is_filesystem_primary: boolean;
  is_filesystem_writable: boolean;
  is_filesystem_fast: boolean;
  entries: Pagination<DirectoryEntry>;
}

export interface Server {
  uuid: string;
  uuid_short: string;
  name: string;
  description: string | null;
  status: 'installing' | 'install_failed' | 'restoring_backup' | null;
  is_suspended: boolean;
  is_owner: boolean;
  permissions: string[];
  node_name: string;
}

export interface ServerListResponse {
  servers: Pagination<Server>;
}

export interface WebsocketCredentials {
  token: string;
  url: string;
}

export interface Account {
  uuid: string;
  username: string;
  email: string;
}

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';

export type PowerState = 'offline' | 'starting' | 'running' | 'stopping';

export interface ResourceUsage {
  memory_bytes: number;
  memory_limit_bytes: number;
  disk_bytes: number;
  state: PowerState;
  network: { rx_bytes: number; tx_bytes: number };
  cpu_absolute: number;
  uptime: number;
}

export interface PublicSettings {
  app: {
    name: string;
  };
  server: {
    max_file_manager_view_size: number;
    max_file_manager_content_search_size: number;
    max_file_manager_search_results: number;
    container_prelude: string;
  };
}

export interface FileRevision {
  id: number;
  user: { username: string; avatar?: string | null } | null;
  size: number;
  is_snapshot: boolean;
  created: string;
}

export interface CopyFile {
  from: string;
  to: string;
}

export interface FileSearchFilters {
  root: string;
  path_filter: { include: string[]; exclude: string[]; case_insensitive: boolean } | null;
  size_filter: { min: number; max: number } | null;
  content_filter: {
    query: string;
    max_search_size: number;
    include_unmatched: boolean;
    case_insensitive: boolean;
  } | null;
}
