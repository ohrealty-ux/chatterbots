# Make a Gary Bot Beacon from a picture (instructions for a Grok Bot)

You are a user's Grok Bot. The user gave you a picture and asked for a Bot Beacon. Do it end to end. Bot Beacons are Gary's (Garyck Arntzen, MIT): https://github.com/SnazzyGaz/bot-beacons . Never put beacon keys, pairing codes, ntfy topics or webhook keys in chat, files the user sees, or any website.

## Before you start
- Needs the Grok Bot desktop app and a Windows 10/11 PC connected to you as one of "my computers". If not, tell the user kindly and stop.
- Ask the user only for what only they can do: approve command cards, type the pairing code, paste the webhook URL and key into the app's Wake hook window, ping the beacon once.

## Step 1: Turn the picture into a skin
1. Make a PNG with a transparent background (remove the plain background by flood-filling from the edges, soften the edge by ~1px; keep a thin light rim if the outline is dark so it shows on dark desktops).
2. Fit it in a 150 x 190 canvas (max 1024 px on a side, under 8 MB), centered.
3. Create a skin folder named after the beacon id (lowercase, hyphens) with `skin.json` and `art/<id>.png`. `skin.json` has a `beacons` entry whose `id` equals the beacon id, with `name`, `color` (a bright colour taken from the picture), `art`, `eye` [x,y] (where the glow sits; pick a spot on the face), `eyeGlow` about 88, `glowOver` 0, `eyeCore` 0, and a calm `anim` (see docs/SKINS.md in Gary's repo).
4. Make a 128 x 128 transparent avatar PNG for the tab picture.
5. Validate and pack: `beaconctl.py skin check <folder>` then `beaconctl.py skin pack <folder>`.

## Step 2: Install and pair Gary's beacon
Gary's own guides are the authority: docs/SETUP.md and AGENT-GUIDE.md in his repo (https://github.com/SnazzyGaz/bot-beacons). Follow SETUP.md exactly: register the beacon id with `agent-set`, build `beacons.json` with `make_beacons.py`, install on the PC (Gary's default is to build on the PC with his install.ps1, which normally avoids the SmartScreen warning; the prebuilt exe from his releases also works, but warn the user that SmartScreen may show "More info, then Run anyway"), copy the skin zip into `%APPDATA%\BotBeacons\skins\`, ask the user for the pairing code and run `beaconctl.py pair`, then send a test message so the beacon glows.

## Step 3: Reply hook (required)
Create the "Bot Beacons reply router" routine with a webhook trigger using Gary's docs/ROUTER-PROMPT.md. Tell the user to copy its webhook URL and key from the Routines tab into the app: right-click the beacon, Bots, Wake hook, then Test, then Save. Then ask the user to ping the beacon and confirm you answer on it.

## Step 4: Finish
Tell the user to right-click the beacon, choose Skin, Theme, then their beacon name to wear the skin. Send `beaconctl.py avatar <id> <avatar.png>`. Setup is done only after the ping test passes.
