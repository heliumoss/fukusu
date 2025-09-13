// Interfaces
export interface UploadPutResult {
  url: string;
  appUrl: string;
  ufsUrl: string;
  fileHash: string;
  serverData: any;
}

export interface FileMetadata {
  key: string;
  name: string;
  size: number;
  type: string;
  customId?: string;
  uploadedAt: number;
  metadata?: Record<string, any>;
  fileHash?: string;
}
