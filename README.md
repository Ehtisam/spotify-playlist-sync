# Spotify Playlist Sync

Spotify Playlist Sync is an Obsidian plugin that saves your Spotify playlists as notes in your vault and keeps them updated. Each playlist becomes its own note with its cover, name, description and track list.

## Note format

Files are named `NNN Playlist Name.md`. Each folder is numbered from 001 on its own.

```
![[Playlist Name.jpg]]

**Description**

1. **Song** - Artist 1, Artist 2
2. **Song** - Artist
```

Covers are saved to a separate folder as `Playlist Name.jpg`. `#` becomes `♯`, `[ ]` becomes `( )`, and characters such as `|`, `:` and `/` become `-`. Emojis are removed from file names but stay inside the note.

## Folders

Playlists are split into three groups. Each group's folder can be changed in the settings.

| Group | Playlists | Default folder |
|---|---|---|
| Profil | Shown on your profile | `001 Playlist/01 Profil` |
| Unyet | Public but not shown on your profile | `001 Playlist/02 Unyet` |
| And Others | Private | `001 Playlist/03 And Others` |
| Covers | | `001 Playlist/04 pl kapak` |

Spotify's API does not expose the order of your profile. The order and the group of each playlist are set in the Playlists section of the settings instead: every playlist can be moved up and down, and between Profil, Unyet, And Others and Kaydetme (don't save).

## How it works

- It syncs when Obsidian opens and every 60 minutes by default. The music icon in the left ribbon syncs on demand.
- Only playlists that changed are rewritten.
- If a playlist is renamed, its note and cover are renamed too, and Obsidian updates the links.
- A new playlist is added at the top (001) of its group: Profil if it is public, And Others if it is private. The rest move down by one.
- A playlist whose visibility changes on Spotify moves to the matching folder by the same rule.
- When a playlist is deleted or set to Kaydetme, its note and cover go to Obsidian's trash (`.trash`).
- Notes are rewritten on every sync, so anything typed into them by hand is not kept.

## Setup

1. Create an app on the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and add `http://127.0.0.1:8888/callback` as a Redirect URI.
2. Put `main.js` and `manifest.json` into `.obsidian/plugins/spotify-playlist-sync/` in your vault.
3. Enable the plugin in Obsidian, paste your app's Client ID into its settings and connect to Spotify.

The plugin is desktop only. Its interface is in Turkish.

## License

[MIT](LICENSE)
