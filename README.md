# OD-11 Web App

A small standalone web app for controlling an **OD-11 speaker**'s volume and playback from a browser — launch it on your laptop while you work, no Bluetooth or Nuimo controller required.

This is a companion to [OD11-remote](https://github.com/paolocamerin/OD11-remote) (Nuimo BLE remote), but fully independent: it talks to the speaker's WebSocket API directly from the browser.

## How it works

The OD-11 exposes a WebSocket at `ws://<speaker-ip>/ws`. This app connects to it directly from client-side JavaScript — no backend, no build step, zero npm dependencies. `server.js` is just a tiny static file server so you have something to point your browser at.

Your speaker's IP address is entered in the browser and stored only in `localStorage` on your machine. It is never written to disk in this repo and never sent anywhere except to the speaker itself.

## Usage

```bash
node server.js
```

Then open [http://localhost:8080](http://localhost:8080), enter your speaker's IP (e.g. `192.168.0.101`), and click **Connect**.

Use a different port with `node server.js --port=3000`.

## Project structure

```
od11-webapp/
├── index.html   # Page markup
├── app.js       # WebSocket client + UI logic
├── style.css    # Styling
├── server.js    # Zero-dependency static file server
└── package.json
```
