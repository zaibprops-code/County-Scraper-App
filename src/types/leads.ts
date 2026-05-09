// ============================================================
// TypeScript types for all lead data structures
// ============================================================

export type SourceType = "probate" | "civil";

export type LeadFilterType = "all" | "probate" | "foreclosure";

export interface ProbateLead {
  id?: number;
  case_number: string;
  filing_date: string | null;
  deceased_name: string | null;
  petitioner: string | null;
  attorney: string | null;
  address: string | null;
  city: string | null;
  state: string;
  zip: string | null;
  county: string;
  case_type: string | null;
  source_file: string;
  raw_data?: Record<string, unknown>;
  created_at?: string;
}

export interface ForeclosureLead {
  id?: number;
  case_number: string;
  filing_date: string | null;
  plaintiff: string | null;
  defendant: string | null;
  attorney: string | null;
  address: string | null;
  city: string | null;
  state: string;
  zip: string | null;
  county: string;
  case_type: string | null;
  source_file: string;
  raw_data?: Record<string, unknown>;
  created_at?: string;
}

export interface ProcessedFile {
  id?: number;
  filename: string;
  source_type: SourceType;
  file_date: string | null;
  row_count: number;
  processed_at?: string;
}

export interface LeadsApiResponse {
  probate: ProbateLead[];
  foreclosure: ForeclosureLead[];
  probateTotal: number;
  foreclosureTotal: number;
  page: number;
  pageSize: number;
}

export interface FiltersState {
  search: string;
  type: LeadFilterType;
  dateFrom: string;
  dateTo: string;
  page: number;
}

export interface CronResult {
  success: boolean;
  filesProcessed: number;
  probateLeadsInserted: number;
  foreclosureLeadsInserted: number;
  message?: string;
  error?: string;
}

export interface DiscoveredFile {
  filename: string;
  url: string;
  sourceType: SourceType;
  fileDate: string | null;
}

export interface DownloadResult {
  filename: string;
  localPath: string;
  sourceType: SourceType;
  fileDate: string | null;
}
