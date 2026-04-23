import type { EmbeddedApp } from "@netless/app-embedded-page-sdk";
import Hls from "hls.js";

import {
  canPlayHlsNatively,
  clamp,
  formatDuration,
  getPlyrEmbedId,
  HLS_TYPES,
} from "./media";
import {
  buildNormalizationPatch,
  createPlayTimeState,
  getProgressTimeMs,
  normalizeStoreState,
} from "./state";
import type {
  PermissionType,
  PlayerOperationType,
  PlayerStoreState,
  PlayTimeState,
} from "./types";
import type { PlayerShell } from "./view";

type MediaElement = HTMLAudioElement | HTMLVideoElement | HTMLDivElement;

interface PlyrPlayer {
  currentTime: number;
  duration: number;
  muted: boolean;
  paused: boolean;
  seeking: boolean;
  speed: number;
  volume: number;
  elements: {
    container?: HTMLElement;
  };
  destroy(): void;
  off(event: string, handler: (event: Event) => void): void;
  on(event: string, handler: (event: Event) => void): void;
  pause(): void;
  play(): Promise<void>;
}

type PlyrConstructor = new (
  target: HTMLElement,
  options?: Record<string, unknown>
) => PlyrPlayer;

interface PlayerStoreLike {
  state: PlayerStoreState;
  setState(state: Partial<PlayerStoreState>): void;
  onStateChanged: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
}

interface EmbeddedPlyrControllerOptions {
  app: EmbeddedApp<any>;
  playerStore: PlayerStoreLike;
  shell: PlayerShell;
  now?: () => number;
}

interface SyncPlayerStateOptions {
  forceAll?: boolean;
  forcePlayTimeState?: boolean;
  forceVolume?: boolean;
  forceMuted?: boolean;
}

type SyncResolveEntry = {
  count: number;
  timer: number | null;
  resolve: () => void;
};

export class EmbeddedPlyrController {
  private readonly app: EmbeddedApp<any>;
  private readonly playerStore: PlayerStoreLike;
  private readonly shell: PlayerShell;
  private readonly now: () => number;

  private player?: PlyrPlayer;
  private playerElement?: MediaElement;
  private customControls?: CustomPlyrControls;
  private hls?: Hls;
  private currentState: PlayerStoreState;
  private playerReady = false;
  private destroyed = false;
  private lastMediaSignature = "";
  private warnings = new Set<string>();
  private youtubeTimeoutTimer?: number;
  private youtubeErrorHandler?: (event: ErrorEvent) => void;
  private calibrationTimer?: number;
  private consistencyTimer?: number;
  private statusTimer?: number;
  private suppressedUntil: Partial<Record<PlayerOperationType, number>> = {};
  private notSyncSeekTimeSet = new Set<number>();
  private syncPromiseResolveMap = new Map<number, SyncResolveEntry>();
  private loadDurationTimer?: number;
  private isLoadDuration = false;

  private readonly handleAppStateChanged = () => {
    void this.onAppStateChanged();
  };

  private readonly handleWritableChanged = () => {
    this.updateControlPermissions();
    this.customControls?.refresh();
    this.render();
    this.updateConsistencyLoop();
  };

  private readonly handleVisibilityChange = () => {
    this.render();
    if (document.visibilityState === "visible") {
      void this.checkPlayerStateConsistency();
    }
  };

  private readonly handlePlayerReady = () => {
    this.playerReady = true;
    this.updateControlPermissions();
    this.customControls?.refresh();
    if (this.currentState.playTimeState && !this.currentState.playTimeState[0] && this.player?.paused) {
      this.setLoading(true);
    } else {
      this.setLoading(false);
    }
    if (this.useCustomControls) {
      this.loadDuration();
    }
    void this.syncPlayerWithState({ forceAll: true });
    this.render();
  };

  private readonly handlePlayerPlay = () => {
    if (!this.player) return;
    if (this.isSuppressed("play")) {
      this.startCalibrationLoop();
      this.updateConsistencyLoop();
      this.render();
      return;
    }

    const permission = this.hasPermission("play");
    if (permission !== "sync") {
      void this.syncPlayerWithState({ forcePlayTimeState: true });
      return;
    }

    let seekTime = this.safeCurrentTime();
    if (this.safeDuration() > 0 && seekTime >= this.safeDuration()) {
      seekTime = 0;
    }

    this.writeState({
      playTimeState: createPlayTimeState(false, seekTime, this.now()),
    });
    this.startCalibrationLoop();
    this.updateConsistencyLoop();
    this.setLoading(false);
    this.render();
  };

  private readonly handlePlayerPause = () => {
    if (!this.player) return;
    if (this.isSuppressed("play")) {
      this.stopCalibrationLoop();
      this.updateConsistencyLoop();
      this.render();
      return;
    }

    const permission = this.hasPermission("play");
    if (permission !== "sync") {
      void this.syncPlayerWithState({ forcePlayTimeState: true });
      return;
    }

    this.writeState({
      playTimeState: createPlayTimeState(true, this.safeCurrentTime(), this.now()),
    });
    this.stopCalibrationLoop();
    this.updateConsistencyLoop();
    this.setLoading(false);
    this.render();
  };

  private readonly handlePlayerSeeked = () => {
    if (!this.player) return;
    const key = Math.floor(this.player.currentTime);
    if (this.notSyncSeekTimeSet.has(key)) {
      this.notSyncSeekTimeSet.delete(key);
      this.setLoading(false);
      this.customControls?.refresh();
      this.render();
      return;
    }
    if (this.isSuppressed("seek")) {
      this.setLoading(false);
      this.render();
      return;
    }

    const permission = this.hasPermission("seek");
    if (permission !== "sync") {
      this.setLoading(false);
      void this.syncPlayerWithState({ forcePlayTimeState: true });
      return;
    }

    if (key !== Math.floor(this.getProgressTimeSeconds())) {
      this.writeState({
        playTimeState: createPlayTimeState(this.player.paused, this.safeCurrentTime(), this.now()),
      });
    }
    this.setLoading(false);
    this.customControls?.refresh();
    this.render();
  };

  private readonly handlePlayerVolumeChange = () => {
    if (!this.player) return;

    const volumePermission = this.hasPermission("volume");
    const mutePermission = this.hasPermission("muted");

    if (volumePermission === "none" && !this.isSuppressed("volume")) {
      void this.syncPlayerWithState({ forceVolume: true });
      return;
    }
    if (mutePermission === "none" && !this.isSuppressed("muted")) {
      void this.syncPlayerWithState({ forceMuted: true });
      return;
    }

    if (
      volumePermission === "sync" &&
      this.currentState.syncVolume &&
      !this.isSuppressed("volume")
    ) {
      this.writeState({ volume: this.player.volume });
    }

    if (
      mutePermission === "sync" &&
      this.currentState.syncMuted &&
      !this.isSuppressed("muted")
    ) {
      this.writeState({ muted: this.player.muted });
    }

    this.customControls?.refresh();
    this.render();
  };

  private readonly handlePlayerEnded = () => {
    if (!this.player) return;
    this.stopCalibrationLoop();
    this.updateConsistencyLoop();
    this.setLoading(false);
    if (this.hasPermission("play") === "sync") {
      this.writeState({
        playTimeState: createPlayTimeState(true, this.safeCurrentTime(), this.now()),
      });
    }
    this.render();
  };

  private readonly handlePlayerError = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    const message =
      detail instanceof Error ? detail.message : detail ? String(detail) : "Unknown Plyr error";
    this.addWarning(`Player error: ${message}`);
  };

  private readonly handlePlayerSeeking = () => {
    this.setLoading(true);
    this.customControls?.refresh();
  };

  private readonly handlePlayerTimeUpdate = () => {
    this.customControls?.refresh();
  };

  constructor({
    app,
    playerStore,
    shell,
    now = () => Date.now(),
  }: EmbeddedPlyrControllerOptions) {
    this.app = app;
    this.playerStore = playerStore;
    this.shell = shell;
    this.now = now;
    this.currentState = normalizeStoreState(playerStore.state, this.now());
  }

  get playerContainer(): HTMLDivElement {
    return this.shell.stage;
  }

  get useCustomControls(): boolean {
    return this.currentState.useCustomControls;
  }

  async mount(): Promise<void> {
    this.syncNormalizationPatch();

    this.playerStore.onStateChanged.addListener(this.handleAppStateChanged);
    this.app.onWritableChanged.addListener(this.handleWritableChanged);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    this.render();
    await this.ensurePlayer();

    this.statusTimer = window.setInterval(() => {
      this.render();
    }, 250);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    this.playerStore.onStateChanged.removeListener(this.handleAppStateChanged);
    this.app.onWritableChanged.removeListener(this.handleWritableChanged);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);

    this.stopCalibrationLoop();
    this.stopConsistencyLoop();
    this.cancelLoadDuration();
    this.clearSyncResolvers();

    if (this.statusTimer) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }

    this.cleanupYouTubeErrorHandling();
    this.destroyMediaBridge();
    this.destroyPlayer();
  }

  private readState(): PlayerStoreState {
    return normalizeStoreState(this.playerStore.state, this.now());
  }

  getTitle(): string {
    return this.currentState.customControlsTitle;
  }

  getProgressTimeSeconds(): number {
    return getProgressTimeMs(
      this.currentState.playTimeState,
      this.now(),
      this.safeDuration()
    ) / 1000;
  }

  getFormattedCurrentTime(): string {
    return formatDuration(this.getProgressTimeSeconds());
  }

  getFormattedDuration(): string {
    return formatDuration(this.safeDuration());
  }

  getPermission(operation: PlayerOperationType): PermissionType {
    return this.hasPermission(operation);
  }

  togglePlay(): void {
    if (!this.player) return;
    this.setLoading(true);
    if (this.player.paused) {
      this.play();
    } else {
      this.pause();
    }
  }

  play(): void {
    if (!this.player) return;
    const permission = this.hasPermission("play");
    if (permission !== "sync") return;
    let seekTime = this.safeCurrentTime();
    if (this.safeDuration() > 0 && seekTime >= this.safeDuration()) {
      seekTime = 0;
    }
    this.writeState({
      playTimeState: createPlayTimeState(false, seekTime, this.now()),
    });
  }

  pause(): void {
    if (!this.player) return;
    const permission = this.hasPermission("play");
    if (permission !== "sync") return;
    this.writeState({
      playTimeState: createPlayTimeState(true, this.safeCurrentTime(), this.now()),
    });
  }

  seekTime(seekTime: number): void {
    if (!this.player) return;
    const permission = this.hasPermission("seek");
    if (permission !== "sync") return;
    const timestamp = this.now();
    if (this.currentState.playTimeState[0] === false) {
      this.writeState({
        playTimeState: [false, Math.floor(timestamp - seekTime * 1000)],
      });
      return;
    }
    this.writeState({
      playTimeState: [true, Math.floor(timestamp - seekTime * 1000), timestamp],
    });
  }

  setVolume(volume: number): void {
    if (!this.player) return;
    const permission = this.hasPermission("volume");
    const nextVolume = clamp(volume, 0, 1);
    if (permission === "sync") {
      this.writeState({ volume: nextVolume });
      return;
    }
    if (permission === "local") {
      this.suppress("volume", 600);
      this.player.volume = nextVolume;
      this.customControls?.refresh();
    }
  }

  setMute(muted: boolean): void {
    if (!this.player) return;
    const permission = this.hasPermission("muted");
    if (permission === "sync") {
      this.writeState({ muted });
      return;
    }
    if (permission === "local") {
      this.suppress("muted", 600);
      this.player.muted = muted;
      this.customControls?.refresh();
    }
  }

  private setLoading(loading: boolean): void {
    this.playerContainer.classList.toggle("loading", loading);
    if (this.customControls) {
      this.customControls.isLoading = loading;
    }
  }

  private syncPlayTimeState(progressTime: number): void {
    const pending = this.syncPromiseResolveMap.get(progressTime);
    if (!pending) return;
    const ready = !this.player?.seeking || pending.count > 10;
    if (ready) {
      pending.resolve();
      if (pending.timer) {
        window.clearTimeout(pending.timer);
        pending.timer = null;
      }
    } else {
      pending.count += 1;
      pending.timer = this.resolveTimer(progressTime);
    }
  }

  private resolveTimer(key: number): number {
    return window.setTimeout(() => {
      this.syncPlayTimeState(key);
    }, 100);
  }

  private clearSyncResolvers(): void {
    this.syncPromiseResolveMap.forEach(entry => {
      if (entry.timer) {
        window.clearTimeout(entry.timer);
      }
    });
    this.syncPromiseResolveMap.clear();
  }

  private syncNormalizationPatch(): void {
    if (!this.app.isWritable) return;
    const normalizedState = this.readState();
    const patch = buildNormalizationPatch(this.playerStore.state, normalizedState);
    if (Object.keys(patch).length > 0) {
      this.playerStore.setState(patch);
    }
    this.currentState = normalizedState;
  }

  private async onAppStateChanged(): Promise<void> {
    if (this.destroyed) return;

    const previousState = this.currentState;
    const nextState = this.readState();
    const mediaChanged = this.getMediaSignature(previousState) !== this.getMediaSignature(nextState);

    this.currentState = nextState;
    this.render();

    if (mediaChanged) {
      await this.ensurePlayer();
      return;
    }

    await this.syncPlayerWithState({
      forcePlayTimeState:
        JSON.stringify(previousState.playTimeState) !== JSON.stringify(nextState.playTimeState),
      forceVolume:
        previousState.syncVolume !== nextState.syncVolume ||
        previousState.volume !== nextState.volume,
      forceMuted:
        previousState.syncMuted !== nextState.syncMuted ||
        previousState.muted !== nextState.muted,
    });
  }

  private getMediaSignature(state: PlayerStoreState): string {
    return [state.src, state.provider || "", state.type, state.poster, String(state.useCustomControls)].join("|");
  }

  private async ensurePlayer(): Promise<void> {
    const state = this.currentState;
    const mediaSignature = this.getMediaSignature(state);

    if (!state.src) {
      this.destroyMediaBridge();
      this.destroyPlayer();
      this.lastMediaSignature = mediaSignature;
      this.playerReady = false;
      this.shell.stage.innerHTML = "";
      this.render();
      return;
    }

    if (this.player && mediaSignature === this.lastMediaSignature) {
      this.render();
      return;
    }

    this.destroyMediaBridge();
    this.destroyPlayer();
    this.cleanupYouTubeErrorHandling();

    this.playerReady = false;
    this.lastMediaSignature = mediaSignature;
    this.playerElement = this.createPlayerElement(state);
    this.shell.stage.innerHTML = "";
    this.shell.stage.appendChild(this.playerElement);

    if (
      (this.playerElement instanceof HTMLAudioElement ||
        this.playerElement instanceof HTMLVideoElement) &&
      HLS_TYPES.has(state.type) &&
      !canPlayHlsNatively(this.playerElement) &&
      Hls.isSupported()
    ) {
      this.hls = new Hls();
      this.hls.loadSource(state.src);
      this.hls.attachMedia(this.playerElement as HTMLVideoElement);
    }

    const autoplay = state.playTimeState[0] === false;
    const { default: PlyrConstructor } = (await import("plyr")) as unknown as {
      default: PlyrConstructor;
    };

    this.player = new PlyrConstructor(this.playerElement, {
      autoplay,
      clickToPlay: false,
      controls: this.useCustomControls
        ? []
        : ["play", "progress", "current-time", "mute", "volume", "fullscreen"],
      fullscreen: { enabled: true, iosNative: false },
      hideControls: false,
      keyboard: { focused: false, global: false },
      muted: state.muted,
      volume: state.volume,
      youtube: {
        autoplay,
        playsinline: 1,
        rel: 0,
      },
    });

    if (state.provider === "youtube") {
      this.setupYouTubeErrorHandling();
    }

    this.bindPlayerEvents();
    if (this.useCustomControls) {
      this.customControls = new CustomPlyrControls(this, this.player);
      this.customControls.refresh();
    }
    this.updateControlPermissions();
    this.render();
  }

  private createPlayerElement(state: PlayerStoreState): MediaElement {
    if (state.provider === "youtube" || state.provider === "vimeo") {
      const container = document.createElement("div");
      container.className = "plyr__video-embed embedded-player";
      container.setAttribute("data-plyr-provider", state.provider);
      container.setAttribute("data-plyr-embed-id", getPlyrEmbedId(state.src, state.provider));
      if (state.poster) {
        container.setAttribute("data-poster", state.poster);
      }
      return container;
    }

    if (state.type.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.className = "embedded-player";
      audio.setAttribute("crossorigin", "anonymous");
      if (state.poster) {
        audio.setAttribute("data-poster", state.poster);
      }
      const source = document.createElement("source");
      source.src = state.src;
      source.type = state.type;
      audio.appendChild(source);
      return audio;
    }

    const video = document.createElement("video");
    video.className = "embedded-player";
    video.setAttribute("crossorigin", "anonymous");
    video.setAttribute("playsinline", "true");
    if (state.poster) {
      video.setAttribute("data-poster", state.poster);
    }
    const source = document.createElement("source");
    source.src = state.src;
    source.type = state.type;
    video.appendChild(source);
    return video;
  }

  private bindPlayerEvents(): void {
    if (!this.player) return;
    this.player.on("ready", this.handlePlayerReady);
    this.player.on("play", this.handlePlayerPlay);
    this.player.on("pause", this.handlePlayerPause);
    this.player.on("seeking", this.handlePlayerSeeking);
    this.player.on("seeked", this.handlePlayerSeeked);
    this.player.on("timeupdate", this.handlePlayerTimeUpdate);
    this.player.on("volumechange", this.handlePlayerVolumeChange);
    this.player.on("ended", this.handlePlayerEnded);
    this.player.on("error", this.handlePlayerError);
  }

  private unbindPlayerEvents(): void {
    if (!this.player) return;
    this.player.off("ready", this.handlePlayerReady);
    this.player.off("play", this.handlePlayerPlay);
    this.player.off("pause", this.handlePlayerPause);
    this.player.off("seeking", this.handlePlayerSeeking);
    this.player.off("seeked", this.handlePlayerSeeked);
    this.player.off("timeupdate", this.handlePlayerTimeUpdate);
    this.player.off("volumechange", this.handlePlayerVolumeChange);
    this.player.off("ended", this.handlePlayerEnded);
    this.player.off("error", this.handlePlayerError);
  }

  private destroyPlayer(): void {
    this.stopCalibrationLoop();
    this.stopConsistencyLoop();
    this.unbindPlayerEvents();
    this.customControls?.destroy();
    this.customControls = undefined;
    if (this.player) {
      this.player.destroy();
      this.player = undefined;
    }
    this.playerElement?.remove();
    this.playerElement = undefined;
    this.playerReady = false;
    this.setLoading(false);
  }

  private destroyMediaBridge(): void {
    this.hls?.destroy();
    this.hls = undefined;
  }

  private async syncPlayerWithState({
    forceAll = false,
    forcePlayTimeState = false,
    forceVolume = false,
    forceMuted = false,
  }: SyncPlayerStateOptions): Promise<void> {
    if (!this.player || !this.playerReady) {
      this.updateConsistencyLoop();
      return;
    }

    const state = this.currentState;

    if (
      (forceAll || forceVolume || state.syncVolume) &&
      Math.abs(this.player.volume - state.volume) > 0.01
    ) {
      this.suppress("volume", 600);
      this.player.volume = state.volume;
    }

    if ((forceAll || forceMuted || state.syncMuted) && this.player.muted !== state.muted) {
      this.suppress("muted", 600);
      this.player.muted = state.muted;
    }

    if (forceAll || forcePlayTimeState) {
      await this.willSyncPlayTimeState(state.playTimeState);
    }

    this.customControls?.refresh();
    this.updateControlPermissions();
    this.updateConsistencyLoop();
    this.render();
  }

  private async willSyncPlayTimeState(playTimeState: PlayTimeState): Promise<void> {
    if (!this.player) return;

    const duration = this.safeDuration();
    const progressTime = clamp(
      getProgressTimeMs(playTimeState, this.now(), duration) / 1000,
      0,
      duration > 0 ? duration : Number.POSITIVE_INFINITY
    );
    const oldPending = this.syncPromiseResolveMap.get(progressTime);
    if (oldPending) {
      if (oldPending.timer) {
        window.clearTimeout(oldPending.timer);
      }
      this.syncPromiseResolveMap.delete(progressTime);
    }

    this.setLoading(true);
    await new Promise<void>(resolve => {
      this.syncPromiseResolveMap.set(progressTime, {
        count: 0,
        timer: null,
        resolve,
      });
      this.syncPlayTimeState(progressTime);
    }).then(() => {
      if (!this.player) return;
      this.player.currentTime = progressTime;
      this.notSyncSeekTimeSet.add(Math.floor(progressTime));
      this.syncPromiseResolveMap.delete(progressTime);
    });

    if (playTimeState[0] === true) {
      this.stopCalibrationLoop();
      this.suppress("play", 1000);
      if (!this.player.paused) {
        this.player.pause();
      }
      this.setLoading(false);
      return;
    }

    this.startCalibrationLoop();
    this.suppress("play", 1000);
    await this.safePlay();
    this.setLoading(false);
  }

  private async safePlay(loop = 0): Promise<void> {
    if (!this.player) return;
    if (loop > 3) {
      this.addWarning("Failed to resume playback after several retries.");
      return;
    }

    try {
      if (this.player.paused) {
        await this.player.play();
      }
    } catch (error) {
      this.player.muted = true;
      await this.safePlay(loop + 1);
      const message = error instanceof Error ? error.message : String(error);
      this.addWarning(`Playback retry triggered after autoplay rejection: ${message}`);
    }
  }

  private startCalibrationLoop(): void {
    if (this.calibrationTimer || this.destroyed) return;
    this.calibrationTimer = window.setInterval(() => {
      this.calibrateProgress();
    }, 4000);
  }

  private stopCalibrationLoop(): void {
    if (this.calibrationTimer) {
      window.clearInterval(this.calibrationTimer);
      this.calibrationTimer = undefined;
    }
    if (this.player) {
      this.player.speed = 1;
    }
  }

  private calibrateProgress(): void {
    if (!this.player || this.currentState.playTimeState[0] === true) {
      return;
    }

    const targetTime = getProgressTimeMs(
      this.currentState.playTimeState,
      this.now(),
      this.safeDuration()
    ) / 1000;
    const delta = targetTime - this.safeCurrentTime();

    if (delta >= 8) {
      this.suppress("seek", 1500);
      this.player.currentTime = clamp(targetTime, 0, this.safeDuration() || targetTime);
      this.player.speed = 1;
      return;
    }

    if (delta >= 6) {
      this.player.speed = 2;
    } else if (delta >= 4) {
      this.player.speed = 1.75;
    } else if (delta >= 2) {
      this.player.speed = 1.5;
    } else if (delta >= 1) {
      this.player.speed = 1.25;
    } else if (delta <= -4) {
      this.player.speed = 0.5;
    } else if (delta <= -1) {
      this.player.speed = 0.75;
    } else {
      this.player.speed = 1;
    }
  }

  private updateConsistencyLoop(): void {
    this.stopConsistencyLoop();
    if (!this.currentState.keepPlayerStateInSync || this.destroyed) {
      return;
    }

    this.consistencyTimer = window.setInterval(() => {
      void this.checkPlayerStateConsistency();
    }, 3000);
  }

  private stopConsistencyLoop(): void {
    if (this.consistencyTimer) {
      window.clearInterval(this.consistencyTimer);
      this.consistencyTimer = undefined;
    }
  }

  private loadDuration(): void {
    this.cancelLoadDuration();
    if (this.destroyed || this.isLoadDuration) {
      return;
    }
    if (!this.isLoadDuration && this.customControls && this.safeDuration()) {
      this.isLoadDuration = true;
      this.customControls.currentTime(this.getProgressTimeSeconds(), this.safeDuration());
      return;
    }
    this.loadDurationTimer = window.setTimeout(() => {
      this.loadDuration();
    }, 1000);
  }

  private cancelLoadDuration(): void {
    if (this.loadDurationTimer) {
      window.clearTimeout(this.loadDurationTimer);
      this.loadDurationTimer = undefined;
    }
  }

  private async checkPlayerStateConsistency(): Promise<void> {
    if (!this.player || !this.playerReady) return;

    const shouldTouchPlayer =
      this.currentState.allowBackgroundPlayback || document.visibilityState !== "hidden";
    if (!shouldTouchPlayer) return;

    const expectedPaused = this.currentState.playTimeState[0];
    const drift = this.computeDriftSeconds();

    if (expectedPaused !== this.player.paused || Math.abs(drift) > 2) {
      await this.willSyncPlayTimeState(this.currentState.playTimeState);
      this.render();
    }
  }

  private hasPermission(operation: PlayerOperationType): PermissionType {
    if (operation === "volume" && !this.currentState.syncVolume) {
      return "local";
    }
    if (operation === "muted" && !this.currentState.syncMuted) {
      return "local";
    }
    return this.app.isWritable ? "sync" : "none";
  }

  private updateControlPermissions(): void {
    if (!this.player) return;
    if (this.useCustomControls) {
      this.customControls?.refresh();
      return;
    }
    const container = this.player.elements.container as HTMLElement | undefined;
    if (!container) return;

    const playPermission = this.hasPermission("play");
    const seekPermission = this.hasPermission("seek");
    const volumePermission = this.hasPermission("volume");
    const mutePermission = this.hasPermission("muted");

    this.setInteractive(
      container,
      "button[data-plyr='play']",
      playPermission === "sync"
    );
    this.setInteractive(
      container,
      "input[data-plyr='seek'], .plyr__progress__container",
      seekPermission === "sync"
    );
    this.setInteractive(
      container,
      "input[data-plyr='volume']",
      volumePermission !== "none"
    );
    this.setInteractive(
      container,
      "button[data-plyr='mute']",
      mutePermission !== "none"
    );
    this.setInteractive(
      container,
      "button[data-plyr='fullscreen']",
      true
    );
  }

  private setInteractive(
    container: HTMLElement,
    selector: string,
    interactive: boolean
  ): void {
    container.querySelectorAll(selector).forEach(node => {
      if (node instanceof HTMLButtonElement || node instanceof HTMLInputElement) {
        node.disabled = !interactive;
      }
      if (node instanceof HTMLElement) {
        node.style.pointerEvents = interactive ? "" : "none";
        node.classList.toggle("control-disabled", !interactive);
      }
    });
  }

  private writeState(patch: Partial<PlayerStoreState>): void {
    if (!this.app.isWritable || Object.keys(patch).length === 0) return;
    this.playerStore.setState(patch);
    this.currentState = this.readState();
  }

  private suppress(operation: PlayerOperationType, durationMs: number): void {
    this.suppressedUntil[operation] = this.now() + durationMs;
  }

  private isSuppressed(operation: PlayerOperationType): boolean {
    return (this.suppressedUntil[operation] || 0) > this.now();
  }

  private safeCurrentTime(): number {
    return this.player && Number.isFinite(this.player.currentTime) ? this.player.currentTime : 0;
  }

  private safeDuration(): number {
    return this.player && Number.isFinite(this.player.duration) ? this.player.duration : 0;
  }

  private computeDriftSeconds(): number {
    if (!this.player || !this.playerReady) return 0;
    const syncedTime =
      getProgressTimeMs(this.currentState.playTimeState, this.now(), this.safeDuration()) / 1000;
    return syncedTime - this.safeCurrentTime();
  }

  private setupYouTubeErrorHandling(): void {
    this.youtubeErrorHandler = event => {
      const target = event.target as HTMLScriptElement | null;
      if (target?.tagName === "SCRIPT" && target.src.includes("youtube.com/iframe_api")) {
        this.addWarning("Failed to load YouTube iframe API.");
      }
    };
    window.addEventListener("error", this.youtubeErrorHandler, true);

    this.youtubeTimeoutTimer = window.setTimeout(() => {
      if (!this.playerElement) return;
      const iframe = this.playerElement.querySelector("iframe");
      if (!iframe || !iframe.src) {
        this.addWarning("YouTube iframe was not ready after 10 seconds.");
      }
    }, 10000);
  }

  private cleanupYouTubeErrorHandling(): void {
    if (this.youtubeErrorHandler) {
      window.removeEventListener("error", this.youtubeErrorHandler, true);
      this.youtubeErrorHandler = undefined;
    }
    if (this.youtubeTimeoutTimer) {
      window.clearTimeout(this.youtubeTimeoutTimer);
      this.youtubeTimeoutTimer = undefined;
    }
  }

  private addWarning(message: string): void {
    this.warnings.add(message);
    console.warn("[EmbeddedPlyr]", message);
    this.render();
  }

  private render(): void {
    const state = this.currentState;
    this.shell.root.dataset.writable = this.app.isWritable ? "true" : "false";
    this.shell.root.dataset.playing = state.playTimeState[0] ? "false" : "true";
    this.shell.root.dataset.customControls = state.useCustomControls ? "true" : "false";
    this.shell.root.dataset.audio = state.type.startsWith("audio/") ? "true" : "false";
    this.customControls?.refresh();
  }
}

export class CustomPlyrControls {
  private readonly controller: EmbeddedPlyrController;
  private readonly plyr: PlyrPlayer;
  readonly ui: HTMLDivElement;

  private playButton!: HTMLButtonElement;
  private muteButton!: HTMLButtonElement;
  private volumeSliderContainer!: HTMLDivElement;
  private volumeSlider!: HTMLDivElement;
  private volumeSliderButton!: HTMLButtonElement;
  private currentTimeNode!: HTMLSpanElement;
  private durationNode!: HTMLSpanElement;
  private progressSliderContainer!: HTMLDivElement;
  private progressSlider!: HTMLDivElement;
  private progressSliderButton!: HTMLButtonElement;
  private titleNode!: HTMLSpanElement;

  private isDraggingProgress = false;
  private dragStartX?: [number, number];
  private showControlsTimer: number | null = null;
  private resizeObserver?: ResizeObserver;
  private loading = false;

  constructor(controller: EmbeddedPlyrController, plyr: PlyrPlayer) {
    this.controller = controller;
    this.plyr = plyr;
    this.ui = this.createUI();
    this.controller.playerContainer.appendChild(this.ui);
    this.initResizeObserver();
    this.bindEvent();
    this.refresh();
  }

  get isLoading(): boolean {
    return this.loading;
  }

  set isLoading(value: boolean) {
    this.loading = value;
    this.controller.playerContainer.classList.toggle("loading", value);
  }

  destroy(): void {
    this.unbindEvent();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    if (this.showControlsTimer) {
      window.clearTimeout(this.showControlsTimer);
      this.showControlsTimer = null;
    }
    this.ui.remove();
  }

  refresh(): void {
    this.title(this.controller.getTitle());
    this.pause(this.plyr.paused);
    this.volume(this.plyr.volume, this.plyr.muted);
    if (!this.isDraggingProgress) {
      this.currentTime(this.controller.getProgressTimeSeconds(), this.plyr.duration || 0);
    }
    this.updatePermissionState();
  }

  private initResizeObserver(): void {
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        this.ui.classList.remove("small", "middle");
        if (width < 200) {
          this.ui.classList.add("small");
        } else if (width <= 310) {
          this.ui.classList.add("middle");
        }
      }
    });
    this.resizeObserver.observe(this.controller.playerContainer);
  }

  private createUI(): HTMLDivElement {
    const ui = document.createElement("div");
    ui.classList.add("custom-plyr-controls");

    this.playButton = document.createElement("button");
    this.playButton.classList.add("custom-plyr-play-button");

    const layoutProgress = document.createElement("div");
    layoutProgress.classList.add("custom-plyr-layout-progress");

    const layoutTitle = document.createElement("div");
    layoutTitle.classList.add("custom-plyr-layout-title");

    this.titleNode = document.createElement("span");
    this.titleNode.classList.add("custom-plyr-title");

    const durationTime = document.createElement("span");
    durationTime.classList.add("custom-plyr-duration-time");
    this.currentTimeNode = document.createElement("span");
    this.currentTimeNode.classList.add("custom-plyr-current-time");
    const split = document.createElement("span");
    split.classList.add("custom-plyr-split-time");
    split.textContent = "/";
    this.durationNode = document.createElement("span");
    this.durationNode.classList.add("custom-plyr-duration");
    durationTime.append(this.currentTimeNode, split, this.durationNode);

    layoutTitle.append(this.titleNode, durationTime);
    this.progressSliderContainer = this.createProgressSliderContainer();
    layoutProgress.append(layoutTitle, this.progressSliderContainer);

    const layoutVolume = document.createElement("div");
    layoutVolume.classList.add("custom-plyr-laout-volume-mute-container");

    this.muteButton = document.createElement("button");
    this.muteButton.classList.add("custom-plyr-mute-button");

    this.volumeSliderContainer = this.createVolumeSliderContainer();
    layoutVolume.append(this.muteButton, this.volumeSliderContainer);

    ui.append(this.playButton, layoutProgress, layoutVolume);
    return ui;
  }

  private updatePermissionState(): void {
    const canPlay = this.controller.getPermission("play") === "sync";
    const canSeek = this.controller.getPermission("seek") === "sync";
    const canVolume = this.controller.getPermission("volume") !== "none";
    const canMute = this.controller.getPermission("muted") !== "none";

    this.playButton.disabled = !canPlay;
    this.progressSliderContainer.classList.toggle("control-disabled", !canSeek);
    this.progressSliderButton.disabled = !canSeek;
    this.muteButton.disabled = !canMute;
    this.volumeSliderContainer.classList.toggle("control-disabled", !canVolume);
    this.volumeSliderButton.disabled = !canVolume;
  }

  private syncPlay = () => {
    if (this.controller.getPermission("play") !== "sync") return;
    this.isLoading = true;
    this.controller.togglePlay();
    this.hideControls();
  };

  private syncMute = () => {
    this.controller.setMute(!this.muteButton.classList.contains("muted"));
    this.hideControls();
  };

  private syncVolume = (num: number) => {
    this.controller.setVolume(num);
    this.hideControls();
  };

  private syncSeek = (seekTime: number) => {
    if (this.controller.getPermission("seek") !== "sync") return;
    this.isLoading = true;
    this.controller.seekTime(seekTime);
  };

  private eventSeek = (e: PointerEvent) => {
    if (this.controller.getPermission("seek") !== "sync") return;
    const width = this.progressSliderContainer.offsetWidth || 1;
    const progress = clamp(e.offsetX / width, 0, 1);
    const seekTime = Math.min(Math.max(Math.floor(progress * this.plyr.duration * 1000) / 1000, 0), this.plyr.duration || 0);
    this.syncSeek(seekTime);
    this.hideControls();
  };

  private eventVolume = (e: PointerEvent) => {
    const width = this.volumeSliderContainer.offsetWidth || 1;
    const progress = clamp(e.offsetX / width, 0, 1);
    this.syncVolume(Math.floor(progress * 100) / 100);
    this.hideControls();
  };

  private bindDragProgress = (e: PointerEvent) => {
    if (this.controller.getPermission("seek") !== "sync") return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    this.isDraggingProgress = true;
    const offsetX = e.offsetX + this.progressSliderButton.offsetLeft;
    this.dragStartX = [e.clientX, offsetX];
    window.addEventListener("pointermove", this.dragProgress, { passive: false });
    window.addEventListener("pointerup", this.dragProgressEnd, { passive: false });
    window.addEventListener("pointercancel", this.dragProgressEnd, { passive: false });
  };

  private dragProgress = (e: PointerEvent) => {
    if (this.controller.getPermission("seek") !== "sync" || !this.dragStartX) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const deltaX = e.clientX - this.dragStartX[0];
    const progress = clamp(
      (deltaX + this.dragStartX[1]) / (this.progressSliderContainer.offsetWidth || 1),
      0,
      1
    );
    const seekTime = Math.min(Math.max(Math.floor(progress * this.plyr.duration * 1000) / 1000, 0), this.plyr.duration || 0);
    this.currentTime(seekTime, this.plyr.duration || 0);
  };

  private dragProgressEnd = (e: PointerEvent) => {
    if (this.controller.getPermission("seek") !== "sync" || !this.dragStartX) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const deltaX = e.clientX - this.dragStartX[0];
    const progress = clamp(
      (deltaX + this.dragStartX[1]) / (this.progressSliderContainer.offsetWidth || 1),
      0,
      1
    );
    const seekTime = Math.min(Math.max(Math.floor(progress * this.plyr.duration * 1000) / 1000, 0), this.plyr.duration || 0);
    this.syncSeek(seekTime);
    this.isDraggingProgress = false;
    this.dragStartX = undefined;
    window.removeEventListener("pointermove", this.dragProgress);
    window.removeEventListener("pointerup", this.dragProgressEnd);
    window.removeEventListener("pointercancel", this.dragProgressEnd);
    this.hideControls();
  };

  private bindDragVolume = (e: PointerEvent) => {
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const offsetX = e.offsetX + this.volumeSliderButton.offsetLeft;
    this.dragStartX = [e.clientX, offsetX];
    window.addEventListener("pointermove", this.dragVolume, { passive: false });
    window.addEventListener("pointerup", this.dragVolumeEnd, { passive: false });
    window.addEventListener("pointercancel", this.dragVolumeEnd, { passive: false });
  };

  private dragVolume = (e: PointerEvent) => {
    if (!this.dragStartX) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const deltaX = e.clientX - this.dragStartX[0];
    const progress = clamp(
      (deltaX + this.dragStartX[1]) / (this.volumeSliderContainer.offsetWidth || 1),
      0,
      1
    );
    this.volume(Math.floor(progress * 100) / 100, false);
  };

  private dragVolumeEnd = (e: PointerEvent) => {
    if (!this.dragStartX) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const deltaX = e.clientX - this.dragStartX[0];
    const progress = clamp(
      (deltaX + this.dragStartX[1]) / (this.volumeSliderContainer.offsetWidth || 1),
      0,
      1
    );
    this.syncVolume(Math.floor(progress * 100) / 100);
    this.dragStartX = undefined;
    window.removeEventListener("pointermove", this.dragVolume);
    window.removeEventListener("pointerup", this.dragVolumeEnd);
    window.removeEventListener("pointercancel", this.dragVolumeEnd);
    this.hideControls();
  };

  private bindEvent(): void {
    this.playButton.addEventListener("click", this.syncPlay);
    this.muteButton.addEventListener("click", this.syncMute);
    this.progressSliderContainer.addEventListener("pointerup", this.eventSeek);
    this.volumeSliderContainer.addEventListener("pointerup", this.eventVolume);
    this.progressSliderButton.addEventListener("pointerdown", this.bindDragProgress, {
      capture: true,
      passive: false,
    });
    this.volumeSliderButton.addEventListener("pointerdown", this.bindDragVolume, {
      capture: true,
      passive: false,
    });
    this.controller.playerContainer.addEventListener("mouseenter", this.handleMouseEnter);
    this.controller.playerContainer.addEventListener("mouseleave", this.handleMouseLeave);
    this.controller.playerContainer.addEventListener("touchstart", this.handleTouchStart, {
      passive: false,
    });
    this.ui.addEventListener("touchstart", this.stopPropagationFun, { passive: false });
  }

  private unbindEvent(): void {
    this.playButton.removeEventListener("click", this.syncPlay);
    this.muteButton.removeEventListener("click", this.syncMute);
    this.progressSliderContainer.removeEventListener("pointerup", this.eventSeek);
    this.volumeSliderContainer.removeEventListener("pointerup", this.eventVolume);
    this.progressSliderButton.removeEventListener("pointerdown", this.bindDragProgress);
    this.volumeSliderButton.removeEventListener("pointerdown", this.bindDragVolume);
    this.controller.playerContainer.removeEventListener("mouseenter", this.handleMouseEnter);
    this.controller.playerContainer.removeEventListener("mouseleave", this.handleMouseLeave);
    this.controller.playerContainer.removeEventListener("touchstart", this.handleTouchStart);
    this.ui.removeEventListener("touchstart", this.stopPropagationFun);
    window.removeEventListener("pointermove", this.dragProgress);
    window.removeEventListener("pointerup", this.dragProgressEnd);
    window.removeEventListener("pointercancel", this.dragProgressEnd);
    window.removeEventListener("pointermove", this.dragVolume);
    window.removeEventListener("pointerup", this.dragVolumeEnd);
    window.removeEventListener("pointercancel", this.dragVolumeEnd);
  }

  private stopPropagationFun = (e: TouchEvent | MouseEvent) => {
    e.stopPropagation();
    e.stopImmediatePropagation();
    if ("cancelable" in e && e.cancelable) {
      e.preventDefault();
    }
  };

  private handleTouchStart = (e: TouchEvent) => {
    this.stopPropagationFun(e);
    this.ui.classList.add("active");
    this.hideControls();
  };

  private handleMouseEnter = () => {
    this.ui.classList.add("hover");
  };

  private handleMouseLeave = () => {
    this.hideControls(0);
  };

  private hideControls(timeout = 3000): void {
    if (this.showControlsTimer) {
      window.clearTimeout(this.showControlsTimer);
      this.showControlsTimer = null;
    }
    this.showControlsTimer = window.setTimeout(() => {
      this.showControlsTimer = null;
      this.ui.classList.remove("active", "hover");
    }, timeout);
  }

  private createVolumeSliderContainer(): HTMLDivElement {
    const container = document.createElement("div");
    container.classList.add("custom-plyr-volume-slider-container");

    this.volumeSlider = document.createElement("div");
    this.volumeSlider.classList.add("custom-plyr-volume-slider");

    this.volumeSliderButton = document.createElement("button");
    this.volumeSliderButton.classList.add("custom-plyr-volume-slider-button");

    container.append(this.volumeSlider, this.volumeSliderButton);
    return container;
  }

  private createProgressSliderContainer(): HTMLDivElement {
    const container = document.createElement("div");
    container.classList.add("custom-plyr-progress-slider-container");

    this.progressSlider = document.createElement("div");
    this.progressSlider.classList.add("custom-plyr-progress-slider");

    this.progressSliderButton = document.createElement("button");
    this.progressSliderButton.classList.add("custom-plyr-progress-slider-button");

    container.append(this.progressSlider, this.progressSliderButton);
    return container;
  }

  volume(volume: number, muted?: boolean): void {
    if (typeof muted === "boolean") {
      this.muteButton.classList.toggle("muted", muted);
    }
    const progress = muted ? 0 : Math.floor(clamp(volume, 0, 1) * 100);
    this.volumeSlider.style.width = `${progress}%`;
    this.volumeSliderButton.style.left = `${progress}%`;
  }

  pause(paused: boolean): void {
    this.playButton.classList.toggle("playing", !paused);
    this.ui.classList.toggle("paused", paused);
  }

  currentTime(currentTime: number, duration: number): void {
    this.currentTimeNode.textContent = formatDuration(currentTime);
    this.durationNode.textContent = formatDuration(duration);
    const safeDuration = duration > 0 ? duration : 0;
    const progress = safeDuration > 0 ? Math.floor((currentTime / safeDuration) * 100) : 0;
    this.progressSlider.style.width = `${progress}%`;
    this.progressSliderButton.style.left = `${progress}%`;
  }

  title(title: string): void {
    this.titleNode.textContent = title;
  }
}
