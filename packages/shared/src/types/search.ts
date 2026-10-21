export type SearchResultType = 'case' | 'finding' | 'comment' | 'doc';

export interface SearchResult {
  type: SearchResultType;
  id: string;
  case_id: string;
  title: string;
  snippet: string;
  meta?: {
    status?: string;
    severity?: string;
    risk_level?: string;
  };
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total: number;
}
