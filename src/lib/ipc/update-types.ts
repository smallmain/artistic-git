export type UpdateCheckSource = "manual" | "automatic";

export interface UpdateCheckRequest {
  source?: UpdateCheckSource;
}

export interface UpdateStatusEvent {
  requestId: string;
  source: UpdateCheckSource;
  targetWindowLabel: string | null;
  status: UpdateStatus;
}

export type UpdateStatus =
  | { state: "checking" }
  | { state: "available"; version: string; notes: string | null }
  | {
      state: "downloading";
      version: string;
      notes: string | null;
      downloadedBytes: number;
      totalBytes: number | null;
      progress: number | null;
    }
  | { state: "ready"; version: string; notes: string | null }
  | { state: "notAvailable" }
  | { state: "failed"; message: string; visible: boolean };

export interface UpdateInstallGateResponse {
  blocked: boolean;
  reason: UpdateInstallBlockedReason | null;
  message: string | null;
}

export type UpdateInstallBlockedReason =
  | "gitOperation"
  | "backgroundOperation"
  | "noReadyUpdate"
  | "conflict"
  | "reviewMode";
