export interface PlayerShell {
  root: HTMLDivElement;
  stage: HTMLDivElement;
}

export function createPlayerShell(root: HTMLElement): PlayerShell {
  root.innerHTML = `
    <div class="player-shell">
      <div class="player-stage"></div>
    </div>
  `;

  return {
    root: root.querySelector(".player-shell") as HTMLDivElement,
    stage: root.querySelector(".player-stage") as HTMLDivElement,
  };
}
