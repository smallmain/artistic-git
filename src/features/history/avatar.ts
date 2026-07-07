import type { HistoryAuthor } from "./types";

const avatarPalette = [
  "hsl(199 89% 48%)",
  "hsl(160 84% 39%)",
  "hsl(33 94% 49%)",
  "hsl(262 83% 58%)",
  "hsl(348 83% 47%)",
  "hsl(221 83% 53%)",
];

export interface AvatarPresentation {
  background: string;
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

  return {
    background: avatarPalette[hashString(displayName) % avatarPalette.length],
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
