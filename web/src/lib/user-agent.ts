export type DeviceKind = "desktop" | "mobile" | "tablet";
export type ParsedAgent = { browser: string | null; os: string | null; kind: DeviceKind };

const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/HeadlessChrome\//, "Chrome (headless)"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
  [/curl\//, "curl"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPad/, "iPadOS"],
  [/iPhone|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

/** Readable browser, system and device kind from a User-Agent string (best effort). */
export function parseUserAgent(userAgent: string | null | undefined): ParsedAgent {
  const ua = userAgent ?? "";
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const kind: DeviceKind = /iPad|Tablet/.test(ua)
    ? "tablet"
    : /Mobi|iPhone|Android.+Mobile/.test(ua)
      ? "mobile"
      : ua.includes("Android")
        ? "tablet"
        : "desktop";
  return { browser, os, kind };
}
