import type { MediaProvider } from "./types";

const FILE_EXT_TO_MIME: Record<string, string> = {
  aac: "audio/aac",
  flac: "audio/flac",
  m3u8: "application/vnd.apple.mpegurl",
  m4a: "audio/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  ogv: "video/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  weba: "audio/webm",
  webm: "video/webm",
};

const YOUTUBE_RE =
  /^.*(?:youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|watch\?.+&v=)([^#&?]*).*/i;
const VIMEO_RE = /vimeo\.com\/(?:video\/)?(\d+)/i;

export const HLS_TYPES = new Set([
  "application/x-mpegurl",
  "application/vnd.apple.mpegurl",
]);

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function guessProviderFromSrc(src: string): MediaProvider | undefined {
  if (!src) return undefined;
  if (/youtu(?:\.be|be\.com)/i.test(src)) return "youtube";
  if (/vimeo\.com/i.test(src)) return "vimeo";
  return undefined;
}

export function guessTypeFromSrc(src: string): string {
  if (!src) return "";
  const withoutQuery = src.split(/[?#]/, 1)[0] || src;
  const index = withoutQuery.lastIndexOf(".");
  if (index < 0) return "";
  const ext = withoutQuery.slice(index + 1).toLowerCase();
  return FILE_EXT_TO_MIME[ext] || "";
}

export function getPlyrEmbedId(src: string, provider?: MediaProvider): string {
  if (!src) return "";
  if (provider === "youtube") {
    const match = src.match(YOUTUBE_RE);
    return match?.[1] || src;
  }
  if (provider === "vimeo") {
    const match = src.match(VIMEO_RE);
    return match?.[1] || src;
  }
  return src;
}

export function canPlayHlsNatively(
  element: HTMLVideoElement | HTMLAudioElement
): boolean {
  return Boolean(element.canPlayType("application/vnd.apple.mpegurl"));
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours > 0) {
    return [hours, minutes, remainder]
      .map(part => String(part).padStart(2, "0"))
      .join(":");
  }
  return [minutes, remainder].map(part => String(part).padStart(2, "0")).join(":");
}

export function formatSourceLabel(src: string): string {
  if (!src) return "Not configured";
  try {
    const url = new URL(src);
    return `${url.host}${url.pathname}`;
  } catch {
    return src;
  }
}
