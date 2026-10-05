export type Snippet = { title: string; where: string; code: string };

/** Copy-paste setup text for the supported torrent clients. `token` is the real token only right after creation. */
export function webhookSnippets(url: string, token: string): Snippet[] {
  const header = `Authorization: Bearer ${token}`;
  const curl = `curl -fsS -m 30 -X POST -H "${header}" ${url}`;
  return [
    { title: "qBittorrent", where: "Options > Downloads > Run external program on torrent finished", code: curl },
    {
      title: "rTorrent", where: ".rtorrent.rc",
      code: `method.set_key = event.download.finished, harvest_hook, "execute.throw.bg = curl, -fsS, -m, 30, -X, POST, -H, '${header}', ${url}"`,
    },
    {
      title: "Deluge", where: "Preferences > Execute plugin, event Torrent Complete, command: a script such as /config/harvest-hook.sh",
      code: `#!/bin/sh\n${curl}`,
    },
  ];
}
