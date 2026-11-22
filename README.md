# Sandal Royale server

One Render web service: serves the game (`game.zip`, unpacked at boot) and runs the online lobby on the same port (WebSocket).

- Quick match: per-mode queue, rooms auto-start with 2-6 real players.
- Private rooms: 4-letter code; the host picks the mode and starts.
- Resume: a dropped connection can re-attach to its seat for 20 s.
- `/health` and `/stats` show rooms and players online.
- Friends: 6-letter friend codes, requests/accepts routed by the server (friend lists are saved on each phone), presence.
- Party lobby: invite friends with +, everyone stands in the lobby until the leader starts (members mark ready).
- Region: the main address is https://sandal-royale-eu.onrender.com (Frankfurt, closest Render region to the Gulf). An older address can set `MOVED_TO` so its home page forwards players there and carries their saved profile over.
