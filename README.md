# Sandal Royale server

One Render web service: serves the game (`game.zip`, unpacked at boot) and runs the online lobby on the same port (WebSocket).

- Quick match: per-mode queue, rooms auto-start with 2-6 real players.
- Private rooms: 4-letter code; the host picks the mode and starts.
- Resume: a dropped connection can re-attach to its seat for 20 s.
- `/health` and `/stats` show rooms and players online.
