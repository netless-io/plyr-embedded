export type MediaProvider = "youtube" | "vimeo";

export type PlayTimeState = [false, number] | [true, number, number];

export type PlayerOperationType = "play" | "seek" | "volume" | "muted";

export type PermissionType = "sync" | "local" | "none";

export interface PlayerStoreState {
  src: string;
  provider?: MediaProvider;
  type: string;
  poster: string;
  youtubeOrigin?: string;
  youtubeWidgetReferrer?: string;
  useCustomControls: boolean;
  volume: number;
  muted: boolean;
  playTimeState: PlayTimeState;
  syncVolume: boolean;
  syncMuted: boolean;
  customControlsTitle: string;
  allowBackgroundPlayback: boolean;
  keepPlayerStateInSync: boolean;
}

export interface PlayerStoreInput extends Partial<PlayerStoreState> {
  paused?: boolean;
  currentTime?: number;
  useNewPlayer?: boolean;
}
