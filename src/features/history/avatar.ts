import type { HistoryAuthor } from "./types";

// Soft tinted chips with a same-hue dark label, matching the redesign mockup.
const avatarPalette = [
  { background: "hsl(210 40% 92%)", foreground: "hsl(210 40% 32%)" },
  { background: "hsl(152 32% 90%)", foreground: "hsl(152 40% 30%)" },
  { background: "hsl(36 45% 90%)", foreground: "hsl(36 50% 30%)" },
  { background: "hsl(268 36% 92%)", foreground: "hsl(268 38% 36%)" },
  { background: "hsl(345 40% 93%)", foreground: "hsl(345 45% 36%)" },
  { background: "hsl(188 38% 90%)", foreground: "hsl(188 48% 28%)" },
];

export interface AvatarPresentation {
  background: string;
  foreground: string;
  initials: string;
  remoteUrl: string | null;
}

export function resolveAvatarPresentation(
  author: HistoryAuthor,
  options: { gravatarEnabled?: boolean } = {},
): AvatarPresentation {
  const displayName = author.name.trim() || author.email?.trim() || "?";
  const initials = displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  const swatch = avatarPalette[hashString(displayName) % avatarPalette.length];

  return {
    background: swatch.background,
    foreground: swatch.foreground,
    initials: initials || "?",
    remoteUrl:
      options.gravatarEnabled && author.email
        ? `https://www.gravatar.com/avatar/${encodeURIComponent(
            author.email.trim().toLowerCase(),
          )}?d=404&s=64`
        : null,
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}
