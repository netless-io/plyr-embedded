import { clamp, guessProviderFromSrc, guessTypeFromSrc } from "./media";
import type { PlayTimeState, PlayerStoreInput, PlayerStoreState } from "./types";

export const DEFAULT_STORE_STATE: Omit<PlayerStoreState, "playTimeState"> = {
  src: "",
  provider: undefined,
  type: "",
  poster: "",
  useCustomControls: true,
  volume: 1,
  muted: false,
  syncVolume: false,
  syncMuted: false,
  customControlsTitle: "",
  allowBackgroundPlayback: true,
  keepPlayerStateInSync: true,
};

export function createPausedPlayTimeState(timestamp = Date.now()): PlayTimeState {
  return [true, timestamp, timestamp];
}

export function createPlayTimeState(
  paused: boolean,
  currentTimeSeconds: number,
  timestamp = Date.now()
): PlayTimeState {
  const startTimestamp = Math.floor(timestamp - currentTimeSeconds * 1000);
  return paused ? [true, startTimestamp, timestamp] : [false, startTimestamp];
}

export function coercePlayTimeState(
  value: unknown,
  fallbackTimestamp = Date.now()
): PlayTimeState {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "boolean" &&
    typeof value[1] === "number"
  ) {
    if (value[0] === false) {
      return [false, value[1]];
    }
    if (typeof value[2] === "number") {
      return [true, value[1], value[2]];
    }
  }
  return createPausedPlayTimeState(fallbackTimestamp);
}

export function normalizeStoreState(
  state: PlayerStoreInput | Record<string, unknown>,
  fallbackTimestamp = Date.now()
): PlayerStoreState {
  const rawSrc = typeof state.src === "string" ? state.src : DEFAULT_STORE_STATE.src;
  const provider =
    state.provider === "youtube" || state.provider === "vimeo"
      ? state.provider
      : guessProviderFromSrc(rawSrc);
  const type =
    typeof state.type === "string" && state.type
      ? state.type
      : provider
      ? ""
      : guessTypeFromSrc(rawSrc);

  const normalizedCurrentTime =
    typeof state.currentTime === "number" && Number.isFinite(state.currentTime) && state.currentTime >= 0
      ? state.currentTime
      : 0;
  const normalizedPaused = typeof state.paused === "boolean" ? state.paused : true;

  return {
    src: rawSrc,
    provider,
    type,
    poster: typeof state.poster === "string" ? state.poster : DEFAULT_STORE_STATE.poster,
    useCustomControls:
      typeof state.useCustomControls === "boolean"
        ? state.useCustomControls
        : DEFAULT_STORE_STATE.useCustomControls,
    volume:
      typeof state.volume === "number"
        ? clamp(state.volume, 0, 1)
        : DEFAULT_STORE_STATE.volume,
    muted: typeof state.muted === "boolean" ? state.muted : DEFAULT_STORE_STATE.muted,
    playTimeState: Array.isArray(state.playTimeState)
      ? coercePlayTimeState(state.playTimeState, fallbackTimestamp)
      : createPlayTimeState(normalizedPaused, normalizedCurrentTime, fallbackTimestamp),
    syncVolume:
      typeof state.syncVolume === "boolean"
        ? state.syncVolume
        : DEFAULT_STORE_STATE.syncVolume,
    syncMuted:
      typeof state.syncMuted === "boolean"
        ? state.syncMuted
        : DEFAULT_STORE_STATE.syncMuted,
    customControlsTitle:
      typeof state.customControlsTitle === "string"
        ? state.customControlsTitle
        : DEFAULT_STORE_STATE.customControlsTitle,
    allowBackgroundPlayback:
      typeof state.allowBackgroundPlayback === "boolean"
        ? state.allowBackgroundPlayback
        : DEFAULT_STORE_STATE.allowBackgroundPlayback,
    keepPlayerStateInSync:
      typeof state.keepPlayerStateInSync === "boolean"
        ? state.keepPlayerStateInSync
        : DEFAULT_STORE_STATE.keepPlayerStateInSync,
  };
}

export function getProgressTimeMs(
  playTimeState: PlayTimeState,
  fallbackTimestamp = Date.now(),
  durationSeconds?: number
): number {
  const durationMs =
    typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds * 1000
      : Number.POSITIVE_INFINITY;

  if (playTimeState[0] === true) {
    return clamp(playTimeState[2] - playTimeState[1], 0, durationMs);
  }

  return clamp(fallbackTimestamp - playTimeState[1], 0, durationMs);
}

export function buildNormalizationPatch(
  rawState: PlayerStoreInput | Record<string, unknown>,
  normalizedState: PlayerStoreState
): Partial<PlayerStoreState> {
  const patch: Partial<PlayerStoreState> = {};

  if (typeof rawState.src !== "string") patch.src = normalizedState.src;
  if (
    rawState.provider !== "youtube" &&
    rawState.provider !== "vimeo" &&
    normalizedState.provider
  ) {
    patch.provider = normalizedState.provider;
  }
  if ((typeof rawState.type !== "string" || !rawState.type) && normalizedState.type) {
    patch.type = normalizedState.type;
  }
  if (typeof rawState.poster !== "string") patch.poster = normalizedState.poster;
  if (typeof rawState.useCustomControls !== "boolean") {
    patch.useCustomControls = normalizedState.useCustomControls;
  }
  if (
    typeof rawState.volume !== "number" ||
    !Number.isFinite(rawState.volume) ||
    rawState.volume < 0 ||
    rawState.volume > 1
  ) {
    patch.volume = normalizedState.volume;
  }
  if (typeof rawState.muted !== "boolean") patch.muted = normalizedState.muted;
  if (!Array.isArray(rawState.playTimeState)) patch.playTimeState = normalizedState.playTimeState;
  if (typeof rawState.syncVolume !== "boolean") patch.syncVolume = normalizedState.syncVolume;
  if (typeof rawState.syncMuted !== "boolean") patch.syncMuted = normalizedState.syncMuted;
  if (typeof rawState.customControlsTitle !== "string") {
    patch.customControlsTitle = normalizedState.customControlsTitle;
  }
  if (typeof rawState.allowBackgroundPlayback !== "boolean") {
    patch.allowBackgroundPlayback = normalizedState.allowBackgroundPlayback;
  }
  if (typeof rawState.keepPlayerStateInSync !== "boolean") {
    patch.keepPlayerStateInSync = normalizedState.keepPlayerStateInSync;
  }

  return patch;
}
