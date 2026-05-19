# Aternos Minecraft Command Bot

This is a Mineflayer bot that can join your Aternos server and follow commands you type in Minecraft chat.

## Setup

1. Install Node.js 18 or newer.
2. Install the bot packages:

   ```bash
   npm install
   ```

   On Windows, if PowerShell says `npm.ps1 cannot be loaded`, use `npm.cmd install` instead.

3. Copy `.env.example` to `.env`.
4. Edit `.env`:

   - `MC_HOST`: your Aternos address, like `myserver.aternos.me`
   - `MC_PORT`: usually `25565`
   - `MC_AUTH`: use `offline` for offline/cracked servers, or `microsoft` for a real Minecraft account
   - `MC_USERNAME`: the bot username or Microsoft account email
   - `AUTHORIZED_USERS`: your Minecraft username
   - `SECURITY_AUTH_ENABLED`: set to `true` if your server uses SecurityLogin/AuthMe
   - `SECURITY_AUTH_PASSWORD`: the password the bot should register/login with
   - `AUTO_ACCEPT_RESOURCE_PACK`: keep `true` for servers with a required resource pack

5. Start your Aternos server first. A bot cannot wake an offline Aternos server.
6. Run:

   ```bash
   npm start
   ```

   On Windows with that same PowerShell issue, use `npm.cmd start`.

## Security Login

If your server asks the bot to register or log in after joining, set:

```env
SECURITY_AUTH_ENABLED=true
SECURITY_AUTH_PASSWORD=your-bot-password
SECURITY_AUTH_COMMANDS=/register {password};/login {password}
```

Some login plugins require the password twice when registering. If yours does, use:

```env
SECURITY_AUTH_COMMANDS=/register {password} {password};/login {password}
```

The bot sends these as Minecraft commands after it spawns. Do not commit your real password; keep it in `.env` locally or in Railway Variables.

## Required Resource Pack

`AUTO_ACCEPT_RESOURCE_PACK=true` makes the bot accept the resource pack request that the server sends. Mineflayer does not need to render the pack; it just confirms acceptance so the server lets the bot stay connected.

## Anti-AFK

To prevent being kicked by Aternos for idling, the bot has a built-in Anti-AFK feature. It will perform a tiny movement (look and jump) every 30 seconds if it is not currently doing a task.

- `ANTI_AFK_ENABLED`: set to `true` (default) or `false`
- `ANTI_AFK_INTERVAL_MS`: frequency in milliseconds (default `30000`)

## Deploy To Railway

This project includes a `Dockerfile`, `Procfile`, `railway.json`, and a `/health` endpoint for robust hosting on [Railway](https://railway.com).

1. Push this folder to a GitHub repository.
2. In Railway, create a new project from that GitHub repository.
3. Railway will detect the `Dockerfile` and build the image.
4. Open the service's **Variables** tab and add your config. Railway automatically provides the `PORT` variable used by the health server.
5. Minimum variables to set:
   - `MC_HOST`: your server address
   - `MC_USERNAME`: bot name
   - `AUTHORIZED_USERS`: your username
   - `SECURITY_AUTH_ENABLED`: `true` (if server has login)
   - `SECURITY_AUTH_PASSWORD`: your bot's password

The `/health` endpoint allows Railway to monitor the bot's status. If the bot crashes, Railway will automatically restart it.

## Commands

Type these in Minecraft chat. The default prefix is `!bot`.

```text
!bot help
!bot status
!bot come
!bot follow
!bot follow PlayerName
!bot stop
!bot goto 100 64 -20
!bot mine oak_log 8
!bot dig stone 16
!bot place dirt 100 65 -20
!bot equip diamond_pickaxe hand
!bot equip best
!bot inventory
!bot drop cobblestone 32
!bot craft oak_planks 4
!bot sleep
!bot wake
!bot attack zombie
!bot say hello everyone
```

## Notes

- Keep `AUTHORIZED_USERS` set so other players cannot control the bot.
- The bot can do common survival work: walk, follow, mine nearby blocks, place blocks at coordinates, equip tools, craft from inventory, sleep, attack nearby mobs, and manage inventory.
- More jobs can be added in `src/commands.js`.
- Follow Aternos and server rules. Do not use the bot to bypass anti-AFK systems or keep a server online against the host's terms.
