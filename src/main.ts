import "plyr/dist/plyr.css";
import "./style.css";

import { createEmbeddedApp } from "@netless/app-embedded-page-sdk";

import { EmbeddedPlyrController } from "./controller";
import { createPausedPlayTimeState, DEFAULT_STORE_STATE } from "./state";
import type { PlayerStoreState } from "./types";
import { createPlayerShell } from "./view";

declare global {
  interface Window {
    embeddedPlyrController?: EmbeddedPlyrController;
  }
}

const PLAYER_STORE_ID = "state";

async function bootstrap(): Promise<void> {
  const root = document.querySelector("#app");
  if (!(root instanceof HTMLElement)) {
    throw new Error("Missing #app root element.");
  }

  const shell = createPlayerShell(root);

  try {
    const app = await createEmbeddedApp<Record<string, never>>({ ensureState: {} });
    const playerStore = app.connectStore<PlayerStoreState>(PLAYER_STORE_ID, {
      ...DEFAULT_STORE_STATE,
      playTimeState: createPausedPlayTimeState(),
    });

    const controller = new EmbeddedPlyrController({
      app,
      playerStore,
      shell,
    });
    let destroyed = false;
    const destroyController = () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      void controller.destroy();
      window.embeddedPlyrController = undefined;
    };

    window.embeddedPlyrController = controller;
    window.addEventListener("pagehide", destroyController, { once: true });
    window.addEventListener("beforeunload", destroyController, { once: true });
    await controller.mount();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      "[EmbeddedPlyr] This page needs to run inside Netless EmbeddedPage or use a compatible postMessage host.",
      message
    );
  }
}

void bootstrap();
